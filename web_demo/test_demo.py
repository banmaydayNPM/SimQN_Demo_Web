import concurrent.futures
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from web_demo.server import Handler, ThreadingHTTPServer, build_network, transmit


class NetworkTests(unittest.TestCase):
    def test_custom_channels_and_rebuild(self):
        for links in [9, 20, 45]:
            result = build_network({"nodes": 10, "links": links, "bandwidth": 25, "loss_percent": 30})
            self.assertEqual(len(result["links"]), links)
            self.assertEqual(result["links"], build_network(result["config"])["links"])
            self.assertEqual(result["links"][0]["bandwidth"], 25)
            self.assertEqual(result["links"][0]["drop_rate"], .3)

    def test_topologies_and_real_properties(self):
        for kind, count, expected in [("line", 25, 24), ("tree", 25, 24),
                                      ("grid", 25, 40), ("random", 25, 50),
                                      ("random", 2, 1)]:
            with self.subTest(kind=kind, count=count):
                result = build_network({"topology": kind, "nodes": count,
                                        "memory": 73, "delay_ms": 25})
                self.assertEqual(len(result["nodes"]), count)
                self.assertEqual(len(result["links"]), expected)
                self.assertTrue(result["connected"])
                self.assertEqual(sum(n["degree"] for n in result["nodes"]), expected * 2)
                self.assertTrue(all(n["memory"] == 73 for n in result["nodes"]))
                self.assertTrue(all(e["delay_ms"] == 25 for e in result["links"]))
                pairs = {tuple(sorted((e["source"], e["target"]))) for e in result["links"]}
                self.assertEqual(len(pairs), expected)
                self.assertTrue(all(0 <= a < b < count for a, b in pairs))

    def test_large_network(self):
        result = build_network({"nodes": 1000})
        self.assertEqual(len(result["nodes"]), 1000)
        self.assertEqual(len(result["links"]), 2000)
        self.assertTrue(result["connected"])

    def test_validation(self):
        for data in [None, [], {"nodes": True}, {"nodes": 2.5}, {"nodes": 1001},
                     {"nodes": 1}, {"topology": []}, {"topology": "missing"},
                     {"topology": "grid", "nodes": 99}, {"memory": 0},
                     {"delay_ms": -1}, {"seed": 2**32}]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                build_network(data)

    def test_concurrent_builds_are_reproducible(self):
        data = {"nodes": 50, "seed": 123}
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(build_network, [data] * 3))
        self.assertEqual(results[0]["links"], results[1]["links"])
        self.assertEqual(results[1]["links"], results[2]["links"])


class TransmissionTests(unittest.TestCase):
    def run_transmission(self, **config):
        return transmit({"network": {"topology": "line", "nodes": 4, "seed": 7,
                                     "delay_ms": 10, **config},
                         "source": 0, "target": 3, "requests": 5, "rate": 100})

    def test_multihop_delays_and_forwarding(self):
        result = self.run_transmission()
        self.assertEqual(result["path"], ["n1", "n2", "n3", "n4"])
        self.assertEqual((result["sent"], result["received"], result["lost"]), (5, 5, 0))
        self.assertAlmostEqual(result["elapsed_ms"], 70, places=2)
        self.assertTrue(all(hop["received"] == 5 for hop in result["hops"]))

    def test_total_and_timing_breakdown(self):
        result = transmit({"network": {"topology": "line", "nodes": 5, "seed": 1,
                                       "delay_ms": 10}, "requests": 10, "rate": 100})
        expected = {"total_ms": 130, "emission_span_ms": 90, "propagation_ms": 40,
                    "first_arrival_ms": 40, "last_arrival_ms": 130,
                    "mean_latency_ms": 40, "mean_queue_ms": 0,
                    "last_arrival_emitted_ms": 90, "last_arrival_queue_ms": 0}
        for key, value in expected.items():
            self.assertAlmostEqual(result["timing"][key], value, places=3)
        self.assertGreaterEqual(result["timing"]["wall_run_ms"], 0)

    def test_one_request_zero_delay_and_fractional_rate(self):
        for count, rate, delay in [(1, 100, 0), (1, 100, 10), (4, 3, 10)]:
            result = transmit({"network": {"topology": "line", "nodes": 2, "seed": 1,
                                           "delay_ms": delay}, "requests": count, "rate": rate})
            timing = result["timing"]
            self.assertAlmostEqual(timing["total_ms"], (count - 1) / rate * 1000 + delay, delta=.002)
            self.assertAlmostEqual(timing["mean_latency_ms"], delay, delta=.002)

    def test_partial_loss_can_end_after_last_arrival(self):
        result = transmit({"network": {"topology": "line", "nodes": 2, "seed": 2,
                                       "delay_ms": 1, "loss_percent": 50},
                           "requests": 10, "rate": 1})
        self.assertGreater(result["received"], 0)
        self.assertGreater(result["lost"], 0)
        self.assertEqual(result["timing"]["total_ms"], 9000)
        self.assertLess(result["timing"]["last_arrival_ms"], result["timing"]["total_ms"])
        self.assertEqual(result["timing"]["mean_latency_ms"], 1)

    def test_bandwidth_queues_qubits(self):
        result = self.run_transmission(bandwidth=10)
        self.assertEqual(result["received"], 5)
        self.assertAlmostEqual(result["elapsed_ms"], 430, delta=.1)
        timing = result["timing"]
        self.assertAlmostEqual(timing["mean_latency_ms"], 210, delta=.01)
        self.assertAlmostEqual(timing["mean_queue_ms"], 180, delta=.01)
        self.assertAlmostEqual(timing["last_arrival_queue_ms"], 360, delta=.01)
        self.assertAlmostEqual(timing["last_arrival_ms"], timing["last_arrival_emitted_ms"] +
                               timing["propagation_ms"] + timing["last_arrival_queue_ms"], delta=.002)

    def test_total_loss_and_zero_delay(self):
        result = self.run_transmission(loss_percent=100)
        self.assertEqual(result["received"], 0)
        self.assertEqual(result["lost"], 5)
        self.assertEqual(result["hops"][1]["sent"], 0)
        self.assertEqual(result["timing"]["total_ms"], 40)
        for key in ["first_arrival_ms", "last_arrival_ms", "mean_latency_ms", "mean_queue_ms",
                    "last_arrival_emitted_ms", "last_arrival_queue_ms"]:
            self.assertIsNone(result["timing"][key])
        self.assertEqual(self.run_transmission(delay_ms=0)["received"], 5)

    def test_random_route_uses_displayed_links(self):
        network = build_network({"nodes": 50, "links": 100, "seed": 37})
        data = {"network": network["config"], "source": 49, "target": 0, "requests": 10}
        result = transmit(data)
        links = {frozenset((network["nodes"][e["source"]]["id"], network["nodes"][e["target"]]["id"])) for e in network["links"]}
        self.assertEqual(result["path"][0], "n50")
        self.assertEqual(result["path"][-1], "n1")
        self.assertTrue(all(frozenset(pair) in links for pair in zip(result["path"], result["path"][1:])))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(transmit, [data, data]))
        for item in results:
            item["timing"].pop("wall_run_ms")
        self.assertEqual(results[0], results[1])

    def test_transmission_validation(self):
        network = {"topology": "line", "nodes": 4, "seed": 7}
        for params in [{"source": 0, "target": 0}, {"source": 4}, {"requests": 0},
                       {"requests": 1001}, {"rate": 0}, {"target": True},
                       {"network": {}}, {"network": None},
                       {"network": {**network, "nodes": 1000}, "requests": 1000}]:
            with self.subTest(params=params), self.assertRaises(ValueError):
                transmit({"network": network, **params})
        for params in [{"links": 1}, {"nodes": 3, "links": 4}, {"links": 6001},
                       {"bandwidth": 0}, {"loss_percent": 101}]:
            with self.subTest(params=params), self.assertRaises(ValueError):
                build_network(params)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_page_and_api(self):
        with urlopen(self.url) as response:
            self.assertIn(b"SimQN", response.read())
        request = Request(self.url + "/api/network", data=b'{"nodes": 9, "topology": "grid"}',
                          headers={"Content-Type": "application/json"})
        with urlopen(request) as response:
            self.assertEqual(len(json.load(response)["links"]), 12)
        payload = {"network": {"topology": "line", "nodes": 3, "seed": 1}, "requests": 3}
        request = Request(self.url + "/api/transmit", data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json"})
        with urlopen(request) as response:
            self.assertEqual(json.load(response)["received"], 3)

    def test_bad_requests_and_file_isolation(self):
        for path, body, content_type, status in [
            ("/api/network", b'{"nodes":1001}', "application/json", 400),
            ("/api/network", b"broken", "application/json", 400),
            ("/api/network", b"{}", "text/plain", 415),
            ("/api/network", b" " * 4097, "application/json", 400),
            ("/../server.py", None, "text/plain", 404),
        ]:
            with self.subTest(path=path, status=status):
                request = Request(self.url + path, data=body, headers={"Content-Type": content_type})
                with self.assertRaises(HTTPError) as result:
                    urlopen(request)
                self.assertEqual(result.exception.code, status)
                result.exception.close()


if __name__ == "__main__":
    unittest.main()
