const $ = (id) => document.getElementById(id);
const names = {random: 'Mạng ngẫu nhiên', grid: 'Mạng lưới vuông', tree: 'Mạng cây nhị phân', line: 'Mạng chuỗi tuyến tính'};
const notes = {random: 'Các node kết nối ngẫu nhiên thành một mạng liên thông.', grid: 'Các node xếp thành lưới vuông, nối với các node kề bên.', tree: 'Mỗi node cha kết nối với tối đa hai node con.', line: 'Các node nối tiếp nhau thành một chuỗi.'};
const canvas = $('network'), ctx = canvas.getContext('2d');
let graph = null, positions = [], selected = 0, adjacent = new Set(), width = 0, height = 0;
let scale = 1, baseScale = 1, offsetX = 0, offsetY = 0, pointer = null, frame = 0;
let route = [], routeEdges = new Set();
const fmt = (n) => new Intl.NumberFormat('vi-VN', {maximumFractionDigits: 1}).format(n);
const fmtTime = (n) => n === null ? 'Không có qubit đến B' : `${new Intl.NumberFormat('vi-VN', {maximumFractionDigits: 3}).format(n)} ms`;

function updateConfig() {
  const grid = $('topology').value === 'grid';
  const count = Number($('nodes').value), random = $('topology').value === 'random';
  const maximum = Math.min(6000, count * (count - 1) / 2);
  $('links').min = count - 1;
  $('links').max = maximum;
  $('links').value = random ? Math.min(count * 2, maximum) : grid ? 2 * Math.sqrt(count) * (Math.sqrt(count) - 1) : count - 1;
  $('links').disabled = !random;
  $('links-note').textContent = random ? `Từ ${fmt(count - 1)} đến ${fmt(maximum)} kênh. Mỗi kênh nối hai node; tất cả node cùng một mạng liên thông.` : 'Số kênh được xác định bởi cấu trúc mạng đã chọn.';
  $('topology-note').textContent = notes[$('topology').value];
  $('count-note').textContent = grid ? 'Số node phải là số chính phương: 25, 100, 484, 961…' : 'Thử một mạng lớn để thấy nhiều kết nối hơn.';
  document.querySelectorAll('[data-count]').forEach((button, i) => {
    const n = (grid ? [25,100,484,961] : [25,100,500,1000])[i];
    button.dataset.count = n;
    button.textContent = fmt(n);
    button.classList.toggle('active', Number($('nodes').value) === n);
  });
}
$('topology').addEventListener('change', () => { $('nodes').setCustomValidity(''); updateConfig(); });
$('nodes').addEventListener('input', () => { $('nodes').setCustomValidity(''); updateConfig(); });
document.querySelectorAll('[data-count]').forEach(button => button.addEventListener('click', () => {
  $('nodes').value = button.dataset.count; $('nodes').setCustomValidity(''); updateConfig();
  markNetworkDirty();
}));

async function createNetwork(event) {
  event?.preventDefault();
  const count = Number($('nodes').value), kind = $('topology').value;
  $('nodes').setCustomValidity('');
  if (kind === 'grid' && !Number.isInteger(Math.sqrt(count))) {
    $('nodes').setCustomValidity('Hãy nhập một số chính phương, ví dụ 100, 484 hoặc 961.');
  }
  if (!$('network-form').reportValidity()) return;
  $('config-fields').disabled = true;
  $('transmit-fields').disabled = true;
  $('create').textContent = 'Đang tạo mạng…';
  $('message').className = 'form-message';
  $('message').textContent = 'SimQN đang khởi tạo node và kênh…';
  $('stage').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/network', {method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({topology: kind, nodes: count, links: Number($('links').value), memory: Number($('memory').value), delay_ms: Number($('delay').value), bandwidth: Number($('bandwidth').value), loss_percent: Number($('loss').value)})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không thể tạo mạng.');
    clearTransmission();
    graph = result;
    $('network-name').textContent = names[kind];
    $('class-name').textContent = result.class_name;
    $('node-total').textContent = fmt(result.nodes.length);
    $('link-total').textContent = fmt(result.links.length);
    $('degree-total').textContent = fmt(2 * result.links.length / result.nodes.length);
    $('connection').textContent = result.connected ? 'Liên thông' : 'Chưa liên thông';
    $('engine').textContent = 'SimQN đã kết nối';
    $('message').textContent = `Đã tạo ${fmt(count)} node · ${fmt(result.build_ms)} ms trên máy chủ.`;
    $('stage-empty').hidden = true;
    $('node-select').replaceChildren(...graph.nodes.map((node, index) => new Option(node.id, index)));
    $('node-select').disabled = false;
    for (const id of ['source', 'target']) $(id).replaceChildren(...graph.nodes.map((node, index) => new Option(node.id, index)));
    $('target').value = graph.nodes.length - 1;
    $('target').setCustomValidity('');
    $('transmit-message').textContent = 'Chọn nguồn, đích và số request trên mạng vừa tạo.';
    layout(); selectNode(0);
  } catch (error) {
    $('message').className = 'form-message error';
    $('message').textContent = error instanceof TypeError ? 'Không kết nối được máy chủ. Kiểm tra kết nối rồi thử lại.' : error.message;
    $('engine').textContent = 'Tạo mạng chưa thành công';
    if (!graph) $('stage-empty').textContent = 'Chưa có mạng. Nhấn Tạo mạng để thử lại.';
  } finally {
    $('config-fields').disabled = false;
    $('transmit-fields').disabled = !graph;
    $('create').innerHTML = 'Tạo mạng <span aria-hidden="true">↗</span>';
    $('stage').setAttribute('aria-busy', 'false');
  }
}
$('network-form').addEventListener('submit', createNetwork);
$('network-form').addEventListener('invalid', event => {
  if (event.target.closest('.channel-options')) document.querySelector('.channel-options').open = true;
}, true);

function clearTransmission() {
  route = []; routeEdges.clear();
  $('transmit-result').hidden = true;
  $('transmit-message').className = 'form-message';
  draw();
}
$('transmit-form').addEventListener('input', () => {
  $('target').setCustomValidity(''); clearTransmission();
  $('transmit-message').textContent = 'Cấu hình truyền đã đổi. Nhấn Truyền qubit để chạy.';
});
function markNetworkDirty() {
  if (graph) $('message').textContent = 'Cấu hình đã đổi. Nhấn Tạo mạng để áp dụng; truyền qubit vẫn dùng mạng đang hiển thị.';
}
$('network-form').addEventListener('input', markNetworkDirty);
$('transmit-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!graph) return;
  $('target').setCustomValidity($('source').value === $('target').value ? 'Chọn node đích khác node nguồn.' : '');
  if (!$('transmit-form').reportValidity()) return;
  clearTransmission();
  $('config-fields').disabled = true; $('transmit-fields').disabled = true;
  $('transmit').textContent = 'Đang mô phỏng…';
  $('transmit-message').textContent = 'SimQN đang xử lý các sự kiện gửi và nhận qubit…';
  try {
    const response = await fetch('/api/transmit', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({network:graph.config, source:Number($('source').value), target:Number($('target').value), requests:Number($('requests').value), rate:Number($('rate').value)})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không thể truyền qubit.');
    route = result.path.map(name => graph.nodes.findIndex(node => node.id === name));
    routeEdges = new Set(route.slice(1).map((node, i) => [route[i],node].sort((a,b)=>a-b).join(',')));
    $('route').replaceChildren(...result.path.map((name, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${index === 0 ? 'A · ' : index === result.path.length - 1 ? 'B · ' : ''}${name}${index < result.path.length - 1 ? ' →' : ''}`;
      button.addEventListener('click', () => selectNode(route[index])); return button;
    }));
    $('route-count').textContent = `· ${fmt(result.hops.length)} chặng`;
    $('sent-total').textContent = fmt(result.sent);
    $('received-total').textContent = fmt(result.received);
    $('lost-total').textContent = fmt(result.lost);
    const timing = result.timing;
    $('elapsed-total').textContent = fmtTime(timing.total_ms);
    $('timing-summary').textContent = `Tính từ request đầu tiên tại A (t = 0) đến sự kiện gửi hoặc nhận cuối cùng: ${fmtTime(timing.total_ms)}. ` + (result.lost === 0 ? 'Tất cả qubit đã đến B; đây cũng là thời gian hoàn tất toàn bộ lượt truyền.' : `Có ${fmt(result.lost)} qubit bị mất. Đây là thời gian kết thúc lượt chạy, không phải thời gian giao đủ toàn bộ qubit; demo không gửi lại qubit bị mất.`);
    $('emission-time').textContent = fmtTime(timing.emission_span_ms);
    $('emission-note').textContent = `(${fmt(result.sent)} − 1) ÷ ${fmt(Number($('rate').value))} × 1.000 = ${fmtTime(timing.emission_span_ms)} (theo độ phân giải mô phỏng). Request đầu phát ở t = 0; qubit có thể còn chờ băng thông sau request cuối.`;
    $('propagation-time').textContent = fmtTime(timing.propagation_ms);
    $('propagation-note').textContent = `${fmt(result.hops.length)} chặng × ${fmtTime(graph.config.delay_ms)} mỗi kênh. Không nhân thêm với số request vì các qubit có thể truyền nối tiếp chồng thời gian.`;
    $('first-arrival-time').textContent = fmtTime(timing.first_arrival_ms);
    $('last-arrival-time').textContent = fmtTime(timing.last_arrival_ms);
    $('latency-time').textContent = fmtTime(timing.mean_latency_ms);
    $('queue-time').textContent = fmtTime(timing.mean_queue_ms);
    $('timing-equation').replaceChildren();
    if (timing.last_arrival_ms !== null) {
      for (const [label,value] of [['Mốc phát qubit nhận cuối',timing.last_arrival_emitted_ms],['+ Độ trễ đường đi',timing.propagation_ms],['+ Chờ kênh của qubit đó',timing.last_arrival_queue_ms],['= Lần nhận cuối tại B',timing.last_arrival_ms]]) {
        const item=document.createElement('div'), caption=document.createElement('span'), amount=document.createElement('strong');
        caption.textContent=label;amount.textContent=fmtTime(value);item.append(caption,amount);$('timing-equation').append(item);
      }
    } else {
      $('timing-equation').textContent = 'Không có lần nhận nào tại B nên không tính được thời gian A → B hoặc thời gian chờ của qubit nhận thành công.';
    }
    $('timing-wall').textContent = `Máy chủ xử lý vòng lặp mô phỏng trong ${fmtTime(timing.wall_run_ms)} thực tế. Số này không cộng vào thời gian truyền tin; không gồm tạo mạng, tìm đường, chờ lượt chạy, tải qua HTTP hoặc vẽ giao diện. Độ phân giải thời gian mô phỏng: 0,001 ms.`;
    $('hop-results').replaceChildren(...result.hops.map(hop => {
      const row = document.createElement('tr');
      for (const value of [`${hop.source} → ${hop.target}`, hop.sent, hop.received, hop.sent-hop.received]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      return row;
    }));
    $('transmit-result').hidden = false;
    $('transmit-message').textContent = `Hoàn tất: ${fmt(result.received)}/${fmt(result.sent)} qubit đã đến ${result.path.at(-1)}. Đường truyền được tô đậm trên sơ đồ.`;
    draw();
  } catch(error) {
    $('transmit-message').className = 'form-message error';
    $('transmit-message').textContent = error instanceof TypeError ? 'Mất kết nối máy chủ. Hãy thử lại.' : error.message;
  } finally {
    $('config-fields').disabled = false; $('transmit-fields').disabled = false;
    $('transmit').textContent = 'Truyền qubit →';
  }
});

function layout() {
  cancelAnimationFrame(frame);
  const count = graph.nodes.length, columns = Math.ceil(Math.sqrt(count));
  positions = graph.nodes.map((_, i) => {
    if (graph.topology === 'grid' || graph.topology === 'line') {
      const row = Math.floor(i / columns), col = i % columns;
      return {x: (graph.topology === 'line' && row % 2 ? columns - 1 - col : col) * 36, y: row * 36};
    }
    if (graph.topology === 'tree') {
      const depth = Math.floor(Math.log2(i + 1)), order = i + 1 - 2 ** depth;
      const angle = (order + .5) / 2 ** depth * Math.PI * 2;
      return {x: Math.cos(angle) * depth * 65, y: Math.sin(angle) * depth * 65};
    }
    const angle = i * 2.399963, radius = 23 * Math.sqrt(i);
    return {x: Math.cos(angle) * radius, y: Math.sin(angle) * radius};
  });
  fit();
  if (graph.topology !== 'random' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let iteration = 0;
  // Local repulsion keeps layout work bounded for the 1,000-node demo.
  function settle() {
    for (let step = 0; step < 3; step++) {
      const cells = new Map(), forces = positions.map(() => ({x: 0, y: 0}));
      positions.forEach((p, i) => { const key = `${Math.floor(p.x / 65)},${Math.floor(p.y / 65)}`; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(i); });
      positions.forEach((p, i) => {
        const gx = Math.floor(p.x / 65), gy = Math.floor(p.y / 65);
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
          for (const j of cells.get(`${x},${y}`) || []) {
            if (i === j) continue;
            const dx = p.x - positions[j].x, dy = p.y - positions[j].y;
            const force = 150 / Math.max(16, dx * dx + dy * dy);
            forces[i].x += dx * force; forces[i].y += dy * force;
          }
        }
      });
      graph.links.forEach(edge => {
        const a = positions[edge.source], b = positions[edge.target];
        const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || 1;
        const force = (distance - 65) * .008;
        forces[edge.source].x += dx / distance * force; forces[edge.source].y += dy / distance * force;
        forces[edge.target].x -= dx / distance * force; forces[edge.target].y -= dy / distance * force;
      });
      const cooling = 1 - iteration / 190;
      positions.forEach((p, i) => {p.x += Math.max(-6, Math.min(6, forces[i].x)) * cooling; p.y += Math.max(-6, Math.min(6, forces[i].y)) * cooling;});
      iteration++;
    }
    draw();
    if (iteration < 150) frame = requestAnimationFrame(settle);
  }
  frame = requestAnimationFrame(settle);
}

function selectNode(index) {
  if (!graph || !graph.nodes[index]) return;
  selected = index; adjacent = new Set();
  const channels = graph.links.filter(edge => edge.source === index || edge.target === index);
  channels.forEach(edge => adjacent.add(edge.source === index ? edge.target : edge.source));
  const node = graph.nodes[index];
  $('node-select').value = index;
  $('selected-name').textContent = node.id;
  $('selected-degree').textContent = fmt(node.degree);
  $('selected-memory').textContent = `${fmt(node.memory)} qubit`;
  $('selected-delay').textContent = channels.length ? `${fmt(channels[0].delay_ms)} ms` : 'Không có kênh';
  $('selected-bandwidth').textContent = channels.length ? `${fmt(channels[0].bandwidth)} qubit/s` : 'Không có kênh';
  $('neighbors').replaceChildren(...[...adjacent].sort((a,b) => a-b).map(i => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = graph.nodes[i].id;
    button.addEventListener('click', () => selectNode(i)); return button;
  }));
  canvas.setAttribute('aria-label', `Mạng ${graph.nodes.length} node, ${graph.links.length} kênh. Đang chọn ${node.id}, ${node.degree} kênh trực tiếp.`);
  draw();
}
$('node-select').addEventListener('change', () => selectNode(Number($('node-select').value)));

function fit() {
  if (!positions.length || !width || !height) return;
  const xs = positions.map(p => p.x), ys = positions.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  scale = Math.min(Math.max(1, width - 100) / Math.max(80, maxX - minX), Math.max(1, height - 120) / Math.max(80, maxY - minY), 2);
  baseScale = scale;
  offsetX = width / 2 - (minX + maxX) / 2 * scale;
  offsetY = height / 2 - (minY + maxY) / 2 * scale;
  draw();
}
function draw() {
  const ratio = window.devicePixelRatio || 1;
  ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,width,height);
  if (!graph) return;
  ctx.translate(offsetX, offsetY); ctx.scale(scale, scale);
  const radius = graph.nodes.length > 400 ? 2.6 : 3.5;
  for (const active of [false, true]) {
    ctx.beginPath();
    graph.links.forEach(edge => {
      if ((edge.source === selected || edge.target === selected) !== active) return;
      const a = positions[edge.source], b = positions[edge.target];
      ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
    });
    ctx.strokeStyle = active ? '#438560' : '#cbd8cd'; ctx.lineWidth = (active ? 1.5 : .7) / scale; ctx.stroke();
  }
  positions.forEach((p,i) => {
    ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(radius, 2 / scale),0,Math.PI*2);
    ctx.fillStyle = i === selected || adjacent.has(i) ? '#256e4c' : '#729f80'; ctx.fill();
    if (i === selected) {ctx.beginPath();ctx.arc(p.x,p.y,radius + 5 / scale,0,Math.PI*2);ctx.strokeStyle='#256e4c';ctx.lineWidth=1.5/scale;ctx.stroke();}
    if ($('labels').checked || i === selected) {ctx.font=`${11 / scale}px Segoe UI, sans-serif`;ctx.fillStyle='#34473a';ctx.fillText(graph.nodes[i].id,p.x + radius + 6 / scale,p.y + 3 / scale);}
  });
  if (route.length) {
    ctx.beginPath();
    graph.links.forEach(edge => {
      if (!routeEdges.has([edge.source,edge.target].sort((a,b)=>a-b).join(','))) return;
      const a=positions[edge.source], b=positions[edge.target]; ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
    });
    ctx.strokeStyle='#256e4c';ctx.lineWidth=3/scale;ctx.stroke();
    for (const [i,label] of [[route[0],'A'],[route.at(-1),'B']]) {
      const p=positions[i];ctx.beginPath();ctx.arc(p.x,p.y,9/scale,0,Math.PI*2);ctx.fillStyle='#256e4c';ctx.fill();
      ctx.font=`bold ${10/scale}px Segoe UI, sans-serif`;ctx.fillStyle='#ffffff';ctx.textAlign='center';ctx.fillText(label,p.x,p.y+3/scale);ctx.textAlign='start';
    }
  }
  $('zoom-level').textContent = `${Math.round(scale / baseScale * 100)}%`;
}
function zoom(factor, x = width / 2, y = height / 2) {
  const next = Math.max(baseScale * .3, Math.min(baseScale * 12, scale * factor));
  offsetX = x - (x - offsetX) * next / scale; offsetY = y - (y - offsetY) * next / scale; scale = next; draw();
}
$('fit').addEventListener('click', fit);
$('zoom-in').addEventListener('click', () => zoom(1.3));
$('zoom-out').addEventListener('click', () => zoom(1/1.3));
$('labels').addEventListener('change', draw);
canvas.addEventListener('wheel', event => {event.preventDefault(); const rect=canvas.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .001),event.clientX-rect.left,event.clientY-rect.top);}, {passive:false});
canvas.addEventListener('pointerdown', event => {cancelAnimationFrame(frame);pointer={id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY};canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointermove', event => {if (!pointer || event.pointerId!==pointer.id) return;offsetX+=event.clientX-pointer.x;offsetY+=event.clientY-pointer.y;pointer.x=event.clientX;pointer.y=event.clientY;draw();});
canvas.addEventListener('pointerup', event => {
  if (!pointer || event.pointerId!==pointer.id) return;
  if (Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)<5 && graph) {
    const rect=canvas.getBoundingClientRect(), x=(event.clientX-rect.left-offsetX)/scale,y=(event.clientY-rect.top-offsetY)/scale;
    let nearest=-1, distance=14/scale;
    positions.forEach((p,i)=>{const d=Math.hypot(p.x-x,p.y-y);if(d<distance){nearest=i;distance=d;}});
    if (nearest>=0) selectNode(nearest);
  }
  pointer=null;
});
canvas.addEventListener('pointercancel',()=>{pointer=null;});
new ResizeObserver(entries => {
  width=entries[0].contentRect.width;height=entries[0].contentRect.height;
  const ratio=window.devicePixelRatio||1;canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);fit();
}).observe($('stage'));
updateConfig();createNetwork();
