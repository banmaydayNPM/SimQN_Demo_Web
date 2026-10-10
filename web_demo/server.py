"""Portable, browser-based topology demo backed by this checkout of SimQN."""

import argparse
from collections import deque
import json
import math
from pathlib import Path
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qns.network import QuantumNetwork
from qns.network.topology import GridTopology, LineTopology, RandomTopology, TreeTopology
from qns.utils.rnd import set_seed
from qns.entity.node.app import Application
from qns.entity.qchannel.qchannel import RecvQubitPacket
from qns.models.qubit.qubit import Qubit
from qns.simulator.event import func_to_event
from qns.simulator.simulator import Simulator

STATIC = Path(__file__).with_name("static")
TOPOLOGIES = {"random": RandomTopology, "grid": GridTopology,
              "tree": TreeTopology, "line": LineTopology}
BUILD_LOCK = threading.Lock()


def integer(data, key, default, low, high):
    value = data.get(key, default)
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{key}: cần số nguyên từ {low} đến {high}.")
    return value


def create_network(data):
    if not isinstance(data, dict):
        raise ValueError("Cấu hình mạng phải là một đối tượng JSON.")
    kind = data.get("topology", "random")
    if not isinstance(kind, str) or kind not in TOPOLOGIES:
        raise ValueError("Kiểu mạng không được hỗ trợ.")
    count = integer(data, "nodes", 100, 2, 1000)
    memory = integer(data, "memory", 50, 1, 1000)
    delay = integer(data, "delay_ms", 10, 0, 1000)
    bandwidth = integer(data, "bandwidth", 1000, 1, 10000)
    loss = integer(data, "loss_percent", 0, 0, 100)
    if kind == "grid" and math.isqrt(count) ** 2 != count:
        raise ValueError("Mạng lưới cần số node là số chính phương, ví dụ 100, 225, 400.")
    seed = integer(data, "seed", secrets.randbelow(2**32), 0, 2**32 - 1)
    args = {"nodes_number": count, "qchannel_args": {"delay": delay / 1000,
            "bandwidth": bandwidth, "drop_rate": loss / 100},
            "memory_args": [{"capacity": memory}]}
    if kind == "random":
        maximum = min(6000, count * (count - 1) // 2)
        args["lines_number"] = integer(data, "links", min(count * 2, maximum), count - 1, maximum)
    set_seed(seed)
    network = QuantumNetwork(topo=TOPOLOGIES[kind](**args))
    config = {"topology": kind, "nodes": count, "memory": memory, "delay_ms": delay,
              "bandwidth": bandwidth, "loss_percent": loss, "seed": seed,
              "links": len(network.qchannels)}
    return network, config


def build_network(data):
    started = time.perf_counter()
    # SimQN's random generator is global; keep concurrent browser builds independent.
    with BUILD_LOCK:
        network, config = create_network(data)
    indices = {node: i for i, node in enumerate(network.nodes)}
    nodes = [{"id": node.name, "degree": len(node.qchannels),
              "memory": node.memories[0].capacity} for node in network.nodes]
    links = [{"id": channel.name, "source": indices[channel.node_list[0]],
              "target": indices[channel.node_list[1]],
              "delay_ms": channel.delay_model.calculate() * 1000,
              "bandwidth": channel.bandwidth, "drop_rate": channel.drop_rate}
             for channel in network.qchannels]
    return {"topology": config["topology"], "class_name": TOPOLOGIES[config["topology"]].__name__,
            "nodes": nodes, "links": links, "seed": config["seed"], "config": config,
            "build_ms": round((time.perf_counter() - started) * 1000, 2),
            "connected": network.network_is_connected(network.nodes, network.qchannels)}


def transmit(data):
    if not isinstance(data, dict) or not isinstance(data.get("network"), dict):
        raise ValueError("Cần cấu hình mạng đã tạo để truyền qubit.")
    if "seed" not in data["network"]:
        raise ValueError("Cần seed của mạng đang hiển thị.")
    requests = integer(data, "requests", 10, 1, 1000)
    rate = integer(data, "rate", 100, 1, 10000)
    # The simulator and RNG have process-global settings, so serialize whole runs.
    with BUILD_LOCK:
        network, config = create_network(data["network"])
        source = integer(data, "source", 0, 0, len(network.nodes) - 1)
        target = integer(data, "target", len(network.nodes) - 1, 0, len(network.nodes) - 1)
        if source == target:
            raise ValueError("Node nguồn và node đích phải khác nhau.")
        src, dst = network.nodes[source], network.nodes[target]
        neighbors = {node: [] for node in network.nodes}
        channels = {}
        for channel in network.qchannels:
            a, b = channel.node_list
            neighbors[a].append(b)
            neighbors[b].append(a)
            channels[a, b] = channels[b, a] = channel
        # All channels have equal weights; BFS finds one shortest route without all-pairs tables.
        previous, queue = {src: None}, deque([src])
        while queue and dst not in previous:
            node = queue.popleft()
            for neighbor in neighbors[node]:
                if neighbor not in previous:
                    previous[neighbor] = node
                    queue.append(neighbor)
        if dst not in previous:
            raise ValueError("Không có đường đi giữa hai node.")
        path, node = [], dst
        while node is not None:
            path.append(node)
            node = previous[node]
        path.reverse()
        if requests * (len(path) - 1) > 100000:
            raise ValueError("Lượt chạy vượt 100.000 lần truyền qua kênh. Hãy giảm số request.")
        horizon = requests / rate + len(path) * (config["delay_ms"] / 1000 + requests / config["bandwidth"]) + 1
        simulator = Simulator(0, horizon, accuracy=1000000)
        result = {"path": [n.name for n in path], "sent": requests, "received": 0,
                  "elapsed_ms": 0, "hops": [{"source": a.name, "target": b.name,
                  "sent": 0, "received": 0} for a, b in zip(path, path[1:])]}
        emitted = {}
        arrivals = []
        propagation_ms = (len(path) - 1) * simulator.time(sec=config["delay_ms"] / 1000).sec * 1000

        def forward(index, qubit):
            # shortcut: immediate forwarding bypasses memory, add storage when demonstrating repeater protocols.
            result["elapsed_ms"] = simulator.current_time.sec * 1000
            if index == 0:
                emitted[qubit.name] = simulator.current_time.sec * 1000
            result["hops"][index]["sent"] += 1
            channels[path[index], path[index + 1]].send(qubit, path[index + 1])

        class ReceiveApp(Application):
            def __init__(self, index):
                super().__init__()
                self.index = index

            def handle(self, node, event):
                if not isinstance(event, RecvQubitPacket):
                    return False
                result["elapsed_ms"] = simulator.current_time.sec * 1000
                result["hops"][self.index - 1]["received"] += 1
                if node is dst:
                    result["received"] += 1
                    arrivals.append((simulator.current_time.sec * 1000, emitted[event.qubit.name]))
                else:
                    forward(self.index, event.qubit)
                return True

        for index, node in enumerate(path[1:], start=1):
            node.add_apps(ReceiveApp(index))
        network.install(simulator)
        for i in range(requests):
            network.add_request(src, dst, {"qubits": 1})
            simulator.add_event(func_to_event(simulator.time(sec=i / rate),
                                lambda i=i: forward(0, Qubit(name=f"q{i + 1}"))))
        run_started = time.perf_counter()
        simulator.run()
        wall_run_ms = (time.perf_counter() - run_started) * 1000
        result["lost"] = requests - result["received"]
        result["elapsed_ms"] = round(result["elapsed_ms"], 3)
        latencies = [received - sent for received, sent in arrivals]
        mean_latency = sum(latencies) / len(latencies) if latencies else None
        timing = {
            "total_ms": result["elapsed_ms"],
            "emission_span_ms": max(emitted.values()) - min(emitted.values()),
            "propagation_ms": propagation_ms,
            "first_arrival_ms": arrivals[0][0] if arrivals else None,
            "last_arrival_ms": arrivals[-1][0] if arrivals else None,
            "mean_latency_ms": mean_latency,
            "mean_queue_ms": max(0, mean_latency - propagation_ms) if arrivals else None,
            "last_arrival_emitted_ms": arrivals[-1][1] if arrivals else None,
            "last_arrival_queue_ms": max(0, arrivals[-1][0] - arrivals[-1][1] - propagation_ms) if arrivals else None,
            "wall_run_ms": wall_run_ms,
        }
        result["timing"] = {key: round(value, 3) if value is not None else None
                            for key, value in timing.items()}
        return result


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, message):
        self.respond(status, json.dumps({"error": message}, ensure_ascii=False).encode())

    def do_GET(self):
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8")}
        entry = files.get(self.path.split("?")[0])
        if entry is None:
            self.error(404, "Không tìm thấy trang.")
            return
        self.respond(200, (STATIC / entry[0]).read_bytes(), entry[1])

    def do_POST(self):
        if self.path not in ("/api/network", "/api/transmit"):
            self.error(404, "Không tìm thấy API.")
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self.error(415, "Cần gửi dữ liệu JSON.")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("Kích thước yêu cầu không hợp lệ.")
            self.connection.settimeout(15)
            data = json.loads(self.rfile.read(length))
            result = build_network(data) if self.path == "/api/network" else transmit(data)
        except (ValueError, UnicodeDecodeError) as exc:
            self.error(400, str(exc))
            return
        except TimeoutError:
            self.error(408, "Yêu cầu đã hết thời gian chờ.")
            return
        except Exception:
            self.log_error("SimQN operation failed")
            self.error(500, "SimQN không hoàn tất yêu cầu. Hãy thử lại với cấu hình nhỏ hơn.")
            return
        self.respond(200, json.dumps(result, ensure_ascii=False).encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"SimQN network demo: http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
