function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    return {
        hex: new THREE.Color(`hsl(${h}, 80%, 60%)`),
        css: `hsl(${h}, 80%, 60%)`,
        cssMuted: `hsla(${h}, 80%, 60%, 0.1)`
    };
}

class UniverseViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.container.appendChild(this.renderer.domElement);

        this.planets = new Map();
        this.orbits = new Map();
        this.time = 0;
        
        this.init();
        this.animate();

        window.addEventListener('resize', () => this.onResize());
    }

    init() {
        // Twinkling Starfield with Shader
        const starCount = 3000;
        const starGeometry = new THREE.BufferGeometry();
        const positions = new Float32Array(starCount * 3);
        const phases = new Float32Array(starCount);

        for (let i = 0; i < starCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 150;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 150;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 150;
            phases[i] = Math.random() * Math.PI * 2;
        }

        starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        starGeometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));

        const starMaterial = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 },
                color: { value: new THREE.Color(0xffffff) }
            },
            vertexShader: `
                attribute float phase;
                varying float vOpacity;
                uniform float time;
                void main() {
                    vOpacity = 0.3 + 0.7 * sin(time * 2.0 + phase);
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = 1.5 * (100.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                varying float vOpacity;
                uniform vec3 color;
                void main() {
                    float dist = distance(gl_PointCoord, vec2(0.5, 0.5));
                    if (dist > 0.5) discard;
                    gl_FragColor = vec4(color, vOpacity * (1.0 - dist * 2.0));
                }
            `,
            transparent: true
        });

        this.stars = new THREE.Points(starGeometry, starMaterial);
        this.scene.add(this.stars);

        // Gateway Sun with Glow
        this.sunGroup = new THREE.Group();
        const sunGeo = new THREE.SphereGeometry(1.2, 32, 32);
        this.sunMat = new THREE.MeshBasicMaterial({ 
            color: 0x00f2ff,
            transparent: true,
            opacity: 0.9
        });
        this.sun = new THREE.Mesh(sunGeo, this.sunMat);
        this.sunGroup.add(this.sun);

        // Sun Glow Layers
        this.glows = [];
        for (let i = 1; i <= 3; i++) {
            const glowMat = new THREE.MeshBasicMaterial({ color: 0x00f2ff, transparent: true, opacity: 0.15 / i });
            const glow = new THREE.Mesh(
                new THREE.SphereGeometry(1.2 + (i * 0.3), 32, 32),
                glowMat
            );
            this.sunGroup.add(glow);
            this.glows.push(glowMat);
        }
        this.scene.add(this.sunGroup);

        this.camera.position.z = 12;
        this.camera.position.y = 2;
        this.camera.lookAt(0, 0, 0);
    }

    updateNodes(nodes) {
        const currentIds = new Set(nodes.map(n => n.id));
        
        for (const [id, group] of this.orbits) {
            if (!currentIds.has(id)) {
                this.scene.remove(group);
                if (group.ring) this.scene.remove(group.ring);
                this.orbits.delete(id);
                this.planets.delete(id);
            }
        }

        nodes.forEach((node, index) => {
            const colors = stringToColor(node.id);
            
            if (!this.orbits.has(node.id)) {
                const orbitGroup = new THREE.Group();
                const distance = 4 + (index * 2.0);
                const size = 0.4 + Math.random() * 0.3;
                const speed = 0.003 + Math.random() * 0.005;
                const angle = Math.random() * Math.PI * 2;
                
                const planetGeo = new THREE.SphereGeometry(size, 24, 24);
                const planetMat = new THREE.MeshPhongMaterial({ 
                    color: colors.hex,
                    emissive: colors.hex,
                    emissiveIntensity: 0.2,
                    shininess: 100
                });
                
                const planet = new THREE.Mesh(planetGeo, planetMat);
                orbitGroup.add(planet);
                
                // Orbit line (faint ring)
                const ringGeo = new THREE.RingGeometry(distance - 0.02, distance + 0.02, 64);
                const ringMat = new THREE.MeshBasicMaterial({ color: colors.hex, side: THREE.DoubleSide, transparent: true, opacity: 0.15 });
                const ring = new THREE.Mesh(ringGeo, ringMat);
                ring.rotation.x = Math.PI / 2;
                this.scene.add(ring);
                
                orbitGroup.speed = speed;
                orbitGroup.distance = distance;
                orbitGroup.angle = angle;
                orbitGroup.ring = ring;
                
                this.scene.add(orbitGroup);
                this.orbits.set(node.id, orbitGroup);
                this.planets.set(node.id, planet);
            }

            // Sync Sun color with the last/first node
            if (index === 0) {
                this.sunMat.color.copy(colors.hex);
                this.glows.forEach(g => g.color.copy(colors.hex));
                this.stars.material.uniforms.color.value.copy(colors.hex);
            }
        });

        if (nodes.length === 0) {
            const defaultColor = new THREE.Color(0x00f2ff);
            this.sunMat.color.copy(defaultColor);
            this.glows.forEach(g => g.color.copy(defaultColor));
            this.stars.material.uniforms.color.value.copy(defaultColor);
        }

        if (!this.light) {
            this.light = new THREE.PointLight(0xffffff, 2, 50);
            this.scene.add(this.light);
            this.scene.add(new THREE.AmbientLight(0x202020));
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.time += 0.016;

        if (this.stars) {
            this.stars.material.uniforms.time.value = this.time;
            this.stars.rotation.y += 0.0002;
        }

        if (this.sun) {
            this.sun.rotation.y += 0.01;
            this.sun.scale.setScalar(1 + Math.sin(this.time * 2) * 0.05);
        }

        this.orbits.forEach(group => {
            group.angle += group.speed;
            const planet = group.children[0];
            planet.position.x = Math.cos(group.angle) * group.distance;
            planet.position.z = Math.sin(group.angle) * group.distance;
            planet.rotation.y += 0.02;
        });

        this.renderer.render(this.scene, this.camera);
    }

    onResize() {
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const tabContents = document.querySelectorAll('.tab-content');
    const upstreamList = document.getElementById('upstream-list');
    const toolsContainer = document.getElementById('tools-container');
    const logContent = document.getElementById('log-content');

    const universe = new UniverseViz('universe-container');

    const addServerBtn = document.getElementById('add-server-btn');
    const addServerModal = document.getElementById('add-server-modal');
    const closeModalBtn = document.getElementById('close-modal');
    const addServerForm = document.getElementById('add-server-form');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tabId = item.getAttribute('data-tab');
            navItems.forEach(i => i.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            item.classList.add('active');
            document.getElementById(tabId).classList.add('active');
            if (tabId === 'overview') universe.onResize();
        });
    });

    addServerBtn.onclick = () => addServerModal.classList.add('active');
    closeModalBtn.onclick = () => addServerModal.classList.remove('active');
    window.onclick = (e) => { if (e.target == addServerModal) addServerModal.classList.remove('active'); };

    const transportSelect = document.getElementById('server-transport');
    const urlGroup = document.getElementById('url-group');
    const stdioGroup = document.getElementById('stdio-group');
    const serverUrl = document.getElementById('server-url');

    transportSelect.addEventListener('change', () => {
        const isStdio = transportSelect.value === 'stdio';
        urlGroup.style.display = isStdio ? 'none' : '';
        stdioGroup.style.display = isStdio ? '' : 'none';
        serverUrl.required = !isStdio;
    });

    addServerForm.onsubmit = async (e) => {
        e.preventDefault();
        const id = document.getElementById('server-id').value;
        const transport = transportSelect.value;

        let payload;
        if (transport === 'stdio') {
            const command = document.getElementById('server-command').value;
            const args = document.getElementById('server-args').value.split(' ').filter(Boolean);
            payload = { id, transport, command, args };
        } else {
            const url = serverUrl.value;
            payload = { id, transport, url };
        }

        addLog(`Connecting to MCP-Client: ${id} (${transport})...`, 'system');
        try {
            const response = await fetch('/api/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                addLog(`Success: Connected ${id}`, 'info');
                addServerModal.classList.remove('active');
                addServerForm.reset();
                transportSelect.dispatchEvent(new Event('change'));
                fetchStatus();
                fetchTools();
            } else {
                const result = await response.json();
                addLog(`Error: ${result.error}`, 'warn');
            }
        } catch (error) { addLog(`Network error: ${error.message}`, 'warn'); }
    };

    async function deleteServer(id) {
        if (!confirm(`Disconnect MCP-Client: ${id}?`)) return;
        addLog(`Disconnecting ${id}...`, 'system');
        try {
            const response = await fetch(`/api/servers/${id}`, { method: 'DELETE' });
            if (response.ok) {
                addLog(`Disconnected ${id}.`, 'info');
                fetchStatus();
                fetchTools();
            }
        } catch (error) { addLog(`Error: ${error.message}`, 'warn'); }
    }

    // ── Stat card helpers ──────────────────────────────────────
    function setStatValue(id, value) {
        const el = document.getElementById(id);
        if (!el || el.textContent === String(value)) return;
        el.textContent = value;
        el.classList.remove('stat-pop');
        void el.offsetWidth;
        el.classList.add('stat-pop');
    }

    const TRANSPORT_COLORS = {
        'fastmcp':         '#00f2ff',
        'stdio':           '#a78bfa',
        'streamable-http': '#00ff88',
        'sse':             '#ffd700',
    };

    function updateTransportBreakdown(configured) {
        const breakdown = document.getElementById('transport-breakdown');
        if (!breakdown) return;
        const counts = {};
        configured.forEach(s => { counts[s.transport] = (counts[s.transport] || 0) + 1; });
        breakdown.innerHTML = '';
        Object.entries(counts).forEach(([transport, count]) => {
            const color = TRANSPORT_COLORS[transport] || '#808080';
            const safeClass = 'chip-' + transport.replace(/[^a-z0-9]/g, '-');
            const chip = document.createElement('span');
            chip.className = `transport-chip ${safeClass}`;
            chip.innerHTML = `
                <span class="chip-dot" style="background:${color}"></span>
                ${transport}
                <span class="chip-count">×${count}</span>
            `;
            breakdown.appendChild(chip);
        });
    }

    // ── Fetch status + update stats & breakdown ────────────────
    async function fetchStatus() {
        try {
            const [statusRes, configRes] = await Promise.all([
                fetch('/api/status'),
                fetch('/api/config'),
            ]);
            const data       = await statusRes.json();
            const configured = await configRes.json();

            const connectedMap = new Map(data.upstream.map(s => [s.id, s]));
            const merged = configured.map(cfg => ({
                id: cfg.id,
                transport: cfg.transport,
                online: connectedMap.has(cfg.id),
            }));

            // Stat cards
            const onlineCount = merged.filter(s => s.online).length;
            setStatValue('stat-configured', configured.length);
            setStatValue('stat-online',     onlineCount);
            setStatValue('stat-offline',    configured.length - onlineCount);

            // Transport breakdown chips
            updateTransportBreakdown(configured);

            // Universe viz
            universe.updateNodes(merged.filter(s => s.online));

            // MCP-Clients list
            upstreamList.innerHTML = '';
            if (merged.length === 0) {
                upstreamList.innerHTML = '<p class="empty-state">No MCP-Clients configured.</p>';
                return;
            }
            merged.forEach(server => {
                const colors     = stringToColor(server.id);
                const statusDot  = server.online ? '●' : '○';
                const statusText = server.online ? 'Online' : 'Offline';
                const dotColor   = server.online ? colors.css : '#555';
                const div = document.createElement('div');
                div.className = 'list-item';
                div.innerHTML = `
                    <div class="server-icon" style="background:${colors.cssMuted};color:${dotColor}">${statusDot}</div>
                    <div class="server-info">
                        <h4>${server.id}</h4>
                        <p>${server.transport} • ${statusText}</p>
                    </div>
                    <button class="btn-icon delete-btn" title="Remove">×</button>
                `;
                div.querySelector('.delete-btn').onclick = () => deleteServer(server.id);
                upstreamList.appendChild(div);
            });
        } catch (error) { console.error(error); }
    }

    // ── Fetch tools + update tools stat ───────────────────────
    async function fetchTools() {
        try {
            const response = await fetch('/api/tools');
            const tools = await response.json();

            setStatValue('stat-tools', tools.length);

            toolsContainer.innerHTML = '';
            if (tools.length === 0) {
                toolsContainer.innerHTML = '<p class="empty-state">No tools aggregated.</p>';
                return;
            }
            tools.forEach(tool => {
                const colors = stringToColor(tool.serverId);
                const card = document.createElement('div');
                card.className = 'tool-card';
                card.style.borderLeft = `4px solid ${colors.css}`;
                card.innerHTML = `
                    <h4>${tool.name}</h4>
                    <p>${tool.description || 'No description.'}</p>
                    <div class="tool-meta"><span style="color:${colors.css}">Client: ${tool.serverId}</span></div>
                `;
                toolsContainer.appendChild(card);
            });
        } catch (error) { console.error(error); }
    }

    // ── Log helper — feeds both Activity tab and Mini feed ────
    function addLog(message, type = 'system') {
        const timestamp = new Date().toLocaleTimeString();

        // Main Activity tab
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${timestamp}] ${message}`;
        logContent.appendChild(entry);
        logContent.scrollTop = logContent.scrollHeight;

        // Mini feed on Overview (newest first, max 5)
        const miniLog = document.getElementById('mini-log-content');
        if (!miniLog) return;
        // Remove placeholder on first real entry
        const placeholder = miniLog.querySelector('.mini-log-entry .mini-log-time');
        if (placeholder && placeholder.textContent === '—') miniLog.innerHTML = '';
        const mini = document.createElement('div');
        mini.className = `mini-log-entry ${type}`;
        mini.innerHTML = `<span class="mini-log-time">${timestamp}</span><span>${message}</span>`;
        miniLog.prepend(mini);
        while (miniLog.children.length > 5) miniLog.removeChild(miniLog.lastChild);
    }

    fetchStatus();
    fetchTools();
    setInterval(fetchStatus, 15000);
    setInterval(fetchTools, 15000);
});
