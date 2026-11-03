
/* ARCHNOVA AI - Dashboard, Upload and Approximate Architectural 3D Viewer */
"use strict";

const API = "/api";
let renderer = null;
let animationFrame = null;
let resizeHandler = null;

function $(id) { return document.getElementById(id); }

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
}

// Upload modal
window.openUpload = () => $("uploadModal")?.classList.add("show");
window.closeUpload = () => $("uploadModal")?.classList.remove("show");

$("uploadModal")?.addEventListener("click", function (e) {
    if (e.target === this) window.closeUpload();
});

document.querySelector(".modal-card .close")?.addEventListener("click", window.closeUpload);

document.addEventListener("keydown", e => {
    if (e.key === "Escape") window.closeUpload();
});

$("blueprintFile")?.addEventListener("change", function () {
    if ($("fileLabel")) {
        $("fileLabel").textContent =
            this.files[0]?.name || "Choose blueprint file";
    }
});

// Upload and reconstruct
$("projectForm")?.addEventListener("submit", async function (event) {
    event.preventDefault();

    const name = $("projectName")?.value.trim();
    const file = $("blueprintFile")?.files[0];
    const floorCount = Number($("floorCount")?.value || 1);
    const floorMode = $("floorMode")?.value || "separate";
    const extraFiles = Array.from($("extraBlueprints")?.files || []);
    const message = $("formMessage");
    const button = $("submitBtn");

    if (!name || !file) {
        if (message) {
            message.textContent = "Enter a project name and select a blueprint.";
        }
        return;
    }

    if (floorMode === "separate" && extraFiles.length < floorCount - 1) {
        if (message) message.textContent = `Please select ${floorCount - 1} additional blueprint(s) for the other floors.`;
        return;
    }

    const data = new FormData();
    data.append("blueprint", file);

    if (button) {
        button.disabled = true;
        button.textContent = "Reconstructing 3D...";
    }

    if (message) {
        message.textContent = "Analyzing blueprint and generating 3D geometry...";
    }

    try {
        const response = await fetch(
            `${API}/projects?name=${encodeURIComponent(name)}`,
            { method: "POST", body: data }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.detail || "Blueprint upload failed.");
        }

        // Add remaining floors after the first floor has been created.
        for (let floorIndex = 2; floorIndex <= floorCount; floorIndex++) {
            const floorData = new FormData();
            if (floorMode === "same") {
                floorData.append("duplicate_existing", "true");
            } else {
                floorData.append("blueprint", extraFiles[floorIndex - 2]);
            }
            const floorResponse = await fetch(`${API}/projects/${result.id}/floors?duplicate_existing=${floorMode === "same"}`, {
                method: "POST",
                body: floorMode === "same" ? undefined : floorData
            });
            if (!floorResponse.ok) {
                const floorError = await floorResponse.json();
                throw new Error(floorError.detail || `Could not create floor ${floorIndex}.`);
            }
        }

        window.closeUpload();
        this.reset();

        if ($("fileLabel")) {
            $("fileLabel").textContent = "Choose blueprint file";
        }

        await window.loadProjects();
        await window.show3DModel(result.id, result.name || name);

        $("viewer")?.scrollIntoView({ behavior: "smooth" });

        if (message) {
            message.textContent =
                `Approximate model: ${result.room_count ?? 0} rooms, ` +
                `${result.door_count ?? 0} possible doors, ` +
                `${result.window_count ?? 0} possible windows.`;
        }

    } catch (error) {
        if (message) message.textContent = error.message;
        console.error("ARCHNOVA upload error:", error);

    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "Upload & create project ↗";
        }
    }
});

// Dashboard
window.loadProjects = async function () {
    const grid = $("projectGrid");

    if (!grid) return;

    try {
        const response = await fetch(`${API}/projects`);

        if (!response.ok) {
            throw new Error("Could not load projects.");
        }

        const projects = await response.json();

        if ($("projectCount")) {
            $("projectCount").textContent = projects.length;
        }

        if ($("blueprintCount")) {
            $("blueprintCount").textContent = projects.length;
        }

        if (!projects.length) {
            grid.innerHTML = `
                <div class="empty">
                    <div>▦</div>
                    <h3>Your workspace is clear</h3>
                    <p>Create a project by uploading your first architectural blueprint.</p>
                    <button class="primary" onclick="openUpload()">
                        ＋ Create project
                    </button>
                </div>
            `;
            return;
        }

        grid.innerHTML = projects.map(p => `
            <article class="project-card">
                <div class="symbol">⬡</div>
                <h3>${escapeHTML(p.name)}</h3>
                <p>${escapeHTML(p.filename || "Blueprint")}</p>
                <span class="status-text">
                    ${escapeHTML(p.status || "Processed")}
                </span>
                <div style="margin-top:15px">
                    <button class="primary project-open-button"
                        data-id="${escapeHTML(p.id)}"
                        data-name="${escapeHTML(p.name)}">
                        Open 3D ↗
                    </button>
               
             <button class="project-delete-button"
    data-id="${escapeHTML(p.id)}">
    Delete
</button> 
 </div>
            </article>
        `).join("");

        grid.querySelectorAll(".project-open-button").forEach(button => {
            button.addEventListener("click", async function () {
                await window.show3DModel(
                    this.dataset.id,
                    this.dataset.name
                );

                $("viewer")?.scrollIntoView({ behavior: "smooth" });
            });
        });
        grid.querySelectorAll(".project-delete-button").forEach(button => {
    button.addEventListener("click", async function () {
        const id = this.dataset.id;

        if (!confirm("Are you sure you want to delete this project?")) {
            return;
        }

        try {
            const response = await fetch(`/api/projects/${id}`, {
                method: "DELETE"
            });

            if (response.ok) {
                await window.loadProjects();
            } else {
                alert("Could not delete project.");
            }
        } catch (error) {
            console.error("Delete error:", error);
            alert("Something went wrong.");
        }
    });
});

    } catch (error) {
        console.error("Project dashboard error:", error);
    }
};

function clear3DViewer() {
    if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
    }

    animationFrame = null;

    if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
    }

    resizeHandler = null;

    if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
        renderer = null;
    }
}

function addWall(THREE, group, wall, material) {
    if (!wall.start || !wall.end) return;

    const [x1, z1] = wall.start;
    const [x2, z2] = wall.end;

    const dx = x2 - x1;
    const dz = z2 - z1;

    const length = Math.hypot(dx, dz);

    if (length < 0.03) return;

    const h = Number(wall.height) || 3;

    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(
            length,
            h,
            Math.max(0.08, Number(wall.thickness) || 0.12)
        ),
        material
    );

    mesh.position.set(
        (x1 + x2) / 2,
        h / 2,
        (z1 + z2) / 2
    );

    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    group.add(mesh);
}

function addDoor(THREE, group, door) {
    if (!door.center) return;

    const [x, z] = door.center;
    const w = Math.max(0.45, Number(door.width) || 0.9);
    const horizontal = door.wall_axis === "horizontal";

    const frameMaterial = new THREE.MeshStandardMaterial({
        color: "#dfc49a"
    });

    const doorMaterial = new THREE.MeshStandardMaterial({
        color: "#9b704b"
    });

    const panel = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.9, 2.05, 0.055),
        doorMaterial
    );

    panel.position.set(x, 1.025, z);
    panel.rotation.y = horizontal ? -0.48 : Math.PI / 2 - 0.48;

    group.add(panel);

    const postGeometry = new THREE.BoxGeometry(0.07, 2.12, 0.10);

    [-w / 2, w / 2].forEach(offset => {
        const post = new THREE.Mesh(postGeometry, frameMaterial);

        if (horizontal) {
            post.position.set(x + offset, 1.06, z);
        } else {
            post.position.set(x, 1.06, z + offset);
        }

        group.add(post);
    });
}

function addWindow(THREE, group, item) {
    if (!item.center) return;

    const [x, z] = item.center;
    const w = Math.max(0.45, Number(item.width) || 1.0);
    const horizontal = item.wall_axis === "horizontal";

    const glass = new THREE.Mesh(
        new THREE.BoxGeometry(w, 1.05, 0.075),
        new THREE.MeshStandardMaterial({
            color: "#55c9e8",
            metalness: 0.2,
            roughness: 0.18,
            transparent: true,
            opacity: 0.82
        })
    );

    glass.position.set(x, 1.65, z);
    glass.rotation.y = horizontal ? 0 : Math.PI / 2;

    group.add(glass);

    const sill = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.12, 0.09, 0.15),
        new THREE.MeshStandardMaterial({
            color: "#d5e4ee"
        })
    );

    sill.position.set(x, 1.08, z);
    sill.rotation.y = horizontal ? 0 : Math.PI / 2;

    group.add(sill);
}

// 3D viewer
window.show3DModel = async function (
    projectId,
    projectName = "Building",
    floorNumber = 1
) {
    const viewer = $("viewerCanvas");

    if (!viewer) return;

    if (!window.THREE) {
        alert("Three.js has not loaded. Check your internet connection.");
        return;
    }

    clear3DViewer();
    viewer.innerHTML = "";
    viewer.style.position = "relative";
    viewer.style.overflow = "hidden";

    const loading = document.createElement("div");
    loading.className = "viewer-empty";
    loading.textContent = "Loading your reconstructed building...";

    viewer.appendChild(loading);

    try {
        const response = await fetch(
            `${API}/projects/${projectId}/model?floor=${floorNumber}`
        );

        if (!response.ok) {
            throw new Error("Generated 3D model could not be loaded.");
        }

        const model = await response.json();
        const THREE = window.THREE;
        const availableFloors = model.available_floors || [{ floor_number: 1, filename: "Blueprint" }];
        // Load every registered floor so the building is displayed as one stacked structure.
        const floorModels = await Promise.all(availableFloors.map(async item => {
            const floorResponse = await fetch(`${API}/projects/${projectId}/model?floor=${item.floor_number}`);
            if (!floorResponse.ok) throw new Error(`Could not load floor ${item.floor_number}.`);
            return { floorNumber: Number(item.floor_number), data: await floorResponse.json() };
        }));

        let floorNav = $("floorNavigation");
        if (!floorNav) {
            floorNav = document.createElement("div");
            floorNav.id = "floorNavigation";
            floorNav.className = "floor-navigation";
            viewer.parentElement.insertBefore(floorNav, viewer);
        }
        // Keep floor selection inside Route Navigation; the 3D Studio toolbar
        // only retains the existing Add Floor action to avoid duplicate controls.
        floorNav.innerHTML = `<button type="button" class="add-floor-control" id="addFloorButton">＋ Add Floor</button>`;
        $("addFloorButton")?.addEventListener("click", async () => {
            const duplicate = window.confirm("Press OK to reuse the first floor blueprint. Press Cancel to upload a new blueprint.");
            let floorData = new FormData();
            let url = `${API}/projects/${projectId}/floors?duplicate_existing=${duplicate}`;
            if (!duplicate) {
                const picker = document.createElement("input");
                picker.type = "file";
                picker.accept = ".pdf,.png,.jpg,.jpeg,.tif,.tiff";
                picker.onchange = async () => {
                    if (!picker.files.length) return;
                    floorData.append("blueprint", picker.files[0]);
                    await submitNewFloor(url, floorData, projectId, projectName);
                };
                picker.click();
                return;
            }
            await submitNewFloor(url, undefined, projectId, projectName);
        });

        viewer.innerHTML = "";

        const scene = new THREE.Scene();
        scene.background = new THREE.Color("#07111f");

        const selectedFloorEntry = floorModels.find(item => item.floorNumber === Number(floorNumber)) || floorModels[0];
        const floor = selectedFloorEntry.data.floor || { width: 25, depth: 25, thickness: 0.15 };
        const fw = Math.max(...floorModels.map(item => Number(item.data.floor?.width) || 25));
        const fd = Math.max(...floorModels.map(item => Number(item.data.floor?.depth) || 25));
        const ft = Number(floor.thickness) || 0.15;
        const floorHeight = 3.1; // Keep a subtle 0.1-unit separation between 3m floor plates.
        const totalHeight = Math.max(1, floorModels.length) * floorHeight;

        const camera = new THREE.PerspectiveCamera(
            45,
            (viewer.clientWidth || 800) / (viewer.clientHeight || 500),
            0.1,
            3000
        );

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(viewer.clientWidth || 800, viewer.clientHeight || 500);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        viewer.appendChild(renderer.domElement);

        scene.add(new THREE.HemisphereLight(0xddeeff, 0x26364a, 1.4));
        const light = new THREE.DirectionalLight(0xffffff, 2);
        light.position.set(25, 35 + totalHeight, 20);
        light.castShadow = true;
        scene.add(light);

        const building = new THREE.Group();
        scene.add(building);
        const routeObjects = new THREE.Group();
        scene.add(routeObjects);
        const roomLocations = [];

        floorModels.forEach((entry, index) => {
            const floorData = entry.data;
            const level = new THREE.Group();
            const yOffset = index * floorHeight;
            level.position.y = yOffset;
            level.userData.floorNumber = entry.floorNumber;

            const levelFloor = floorData.floor || {};
            const levelWidth = Number(levelFloor.width) || 25;
            const levelDepth = Number(levelFloor.depth) || 25;
            const levelThickness = Number(levelFloor.thickness) || 0.15;

            // Always expose a selectable entry for every floor, even when the same
            // blueprint is reused or room detection returns no room regions.
            roomLocations.push({
                id: `floor-${entry.floorNumber}-overview`,
                label: `Floor ${entry.floorNumber} · Entire floor`,
                floorNumber: entry.floorNumber,
                x: 0,
                z: 0,
                y: yOffset + 0.12
            });
            const floorMesh = new THREE.Mesh(
                new THREE.BoxGeometry(levelWidth, levelThickness, levelDepth),
                new THREE.MeshStandardMaterial({ color: index % 2 ? "#30465c" : "#26384b", roughness: 0.82 })
            );
            floorMesh.position.y = -levelThickness / 2;
            floorMesh.receiveShadow = true;
            level.add(floorMesh);

            const wallMaterial = new THREE.MeshStandardMaterial({ color: "#a5bad0", roughness: 0.68, metalness: 0.03 });
            (floorData.walls || []).forEach(wall => addWall(THREE, level, wall, wallMaterial));
            (floorData.doors || []).forEach(door => addDoor(THREE, level, door));
            (floorData.windows || []).forEach(item => addWindow(THREE, level, item));

            (floorData.rooms || []).forEach((room, roomIndex) => {
                if (!room.center || !room.width || !room.depth) return;
                const pad = new THREE.Mesh(
                    new THREE.BoxGeometry(Math.max(0.2, room.width * 0.92), 0.025, Math.max(0.2, room.depth * 0.92)),
                    new THREE.MeshStandardMaterial({ color: roomIndex % 2 ? "#31536a" : "#29465d", transparent: true, opacity: 0.5 })
                );
                pad.position.set(room.center[0], 0.015, room.center[1]);
                level.add(pad);
                roomLocations.push({
                    id: `f${entry.floorNumber}-${room.id || roomIndex}`,
                    label: `F${entry.floorNumber} · ${room.name || `Room ${roomIndex + 1}`}`,
                    floorNumber: entry.floorNumber,
                    x: Number(room.center[0]), z: Number(room.center[1]), y: yOffset + 0.12
                });
            });
            building.add(level);
        });

        const grid = new THREE.GridHelper(Math.max(fw, fd) * 1.5, 40, "#31506b", "#182b40");
        grid.position.y = -0.08;
        scene.add(grid);

        const target = new THREE.Vector3(0, (Number(floorNumber) - 1) * floorHeight + 1.2, 0);
        let distance = Math.max(fw, fd, totalHeight, 10) * 1.65;
        let rotationY = 0.7;
        let rotationX = 0.5;

        let dragging = false;
        let previousX = 0;
        let previousY = 0;

        function updateCamera() {
            rotationX = Math.max(
                -1.2,
                Math.min(1.2, rotationX)
            );

            camera.position.set(
                target.x + distance *
                Math.sin(rotationY) * Math.cos(rotationX),

                target.y + distance *
                Math.sin(rotationX),

                target.z + distance *
                Math.cos(rotationY) * Math.cos(rotationX)
            );

            camera.lookAt(target);
        }

        const canvas = renderer.domElement;

        canvas.addEventListener("pointerdown", e => {
            dragging = true;
            previousX = e.clientX;
            previousY = e.clientY;

            canvas.setPointerCapture(e.pointerId);
        });

        canvas.addEventListener("pointermove", e => {
            if (!dragging) return;

            rotationY += (e.clientX - previousX) * 0.008;
            rotationX += (e.clientY - previousY) * 0.008;

            previousX = e.clientX;
            previousY = e.clientY;

            updateCamera();
        });

        canvas.addEventListener("pointerup", () => {
            dragging = false;
        });

        canvas.addEventListener("pointercancel", () => {
            dragging = false;
        });

        canvas.addEventListener("wheel", e => {
            e.preventDefault();

            distance = Math.max(
                2,
                Math.min(
                    300,
                    distance * (e.deltaY > 0 ? 1.1 : 0.9)
                )
            );

            updateCamera();
        }, { passive: false });

        updateCamera();

        // Model information overlay
        const overlay = document.createElement("div");

        overlay.style.cssText = `
            position:absolute;
            top:14px;
            left:14px;
            z-index:5;
            background:rgba(5,15,30,.9);
            border:1px solid #294663;
            border-radius:10px;
            color:#d8eaff;
            padding:12px 15px;
            font-size:12px;
            pointer-events:none;
            max-width:330px;
        `;

        overlay.innerHTML = `
            <strong>${escapeHTML(projectName)}</strong>

            <div style="margin-top:6px;color:#83e5d0">
                ${floorModels.reduce((n, item) => n + (item.data.walls || []).length, 0)} wall sections ·
                ${roomLocations.length} room regions · ${floorModels.length} stacked floors
            </div>

            <div style="margin-top:4px;color:#8ca6c6">
                ${floorModels.reduce((n, item) => n + (item.data.doors || []).length, 0)} possible doors ·
                ${floorModels.reduce((n, item) => n + (item.data.windows || []).length, 0)} possible windows
            </div>

            <div style="margin-top:5px;color:#8ca6c6">
                Drag to rotate · Scroll to zoom
            </div>

            <div style="margin-top:7px;color:#e7c58e">
                Approximate reconstruction — verify against source plan
            </div>
        `;

        viewer.appendChild(overlay);

        // Multi-floor indoor route navigator with independent floor + room selectors.
        // The route UI is additive; it does not alter the source blueprint or existing model geometry.
        const routePanel = document.createElement("div");
        routePanel.className = "archnova-route-panel";
        routePanel.innerHTML = `
            <div class="archnova-route-heading">
                <div class="archnova-route-title"><span>⌖</span> ROUTE NAVIGATION</div>
                <span class="archnova-route-count">${floorModels.length} FLOOR${floorModels.length === 1 ? "" : "S"}</span>
                <button type="button" class="archnova-route-hide" id="routeHideButton" aria-label="Hide route navigation">−</button>
            </div>
            <div class="archnova-route-subtitle">INDOOR DIRECTIONS · BUILDING MAP</div>
            <section class="archnova-route-point">
                <div class="archnova-route-point-title"><i class="route-pin route-pin-start"></i> START LOCATION</div>
                <label>FLOOR<select id="routeStartFloor"></select></label>
                <label>ROOM<select id="routeStartRoom"></select></label>
            </section>
            <div class="archnova-route-divider"><span>ROUTE TO</span></div>
            <section class="archnova-route-point">
                <div class="archnova-route-point-title"><i class="route-pin route-pin-end"></i> DESTINATION</div>
                <label>FLOOR<select id="routeEndFloor"></select></label>
                <label>ROOM<select id="routeEndRoom"></select></label>
            </section>
            <label class="route-connector-label">FLOOR CONNECTION
                <select id="routeConnector">
                    <option value="stairs-north">Stairs · North side</option>
                    <option value="stairs-south">Stairs · South side</option>
                    <option value="lift-north">Lift · North side</option>
                    <option value="lift-south">Lift · South side</option>
                </select>
            </label>
            <div class="archnova-route-actions">
                <button type="button" id="showRouteButton"><span>➤</span> Show route</button>
                <button type="button" id="clearRouteButton">Clear</button>
                <button type="button" id="routeVoiceButton" aria-pressed="false">🔊 Voice guidance: Off</button>
            </div>
            <div class="archnova-route-legend"><i></i> Suggested route <b>●</b> Start <em>●</em> Destination</div>
            <small id="routeStatus">Choose a floor and room for both locations.</small>
        `;
        viewer.appendChild(routePanel);

        const routeShowButton = document.createElement("button");
        routeShowButton.type = "button";
        routeShowButton.id = "routeShowButton";
        routeShowButton.className = "archnova-route-show";
        routeShowButton.textContent = "⌖ Show navigation";
        routeShowButton.style.display = "none";
        viewer.appendChild(routeShowButton);

        const floorSelectOptions = floorModels.map(entry =>
            `<option value="${entry.floorNumber}">Floor ${entry.floorNumber}</option>`
        ).join("");
        const startFloorSelect = routePanel.querySelector("#routeStartFloor");
        const endFloorSelect = routePanel.querySelector("#routeEndFloor");
        const startRoomSelect = routePanel.querySelector("#routeStartRoom");
        const endRoomSelect = routePanel.querySelector("#routeEndRoom");
        startFloorSelect.innerHTML = floorSelectOptions;
        endFloorSelect.innerHTML = floorSelectOptions;
        startFloorSelect.value = String(floorModels[0].floorNumber);
        endFloorSelect.value = String(floorModels[Math.min(1, floorModels.length - 1)].floorNumber);

        const roomChoicesByFloor = new Map();
        floorModels.forEach(entry => {
            const existing = roomLocations.filter(room => room.floorNumber === entry.floorNumber && !room.id.endsWith("-overview"));
            const floorInfo = entry.data.floor || {};
            const width = Number(floorInfo.width) || fw;
            const depth = Number(floorInfo.depth) || fd;
            const choices = existing.slice();
            // Ensure each floor offers Room 1–10 when the blueprint has fewer detected room labels.
            // Extra entries are approximate navigation placeholders, clearly identified in status text.
            for (let i = choices.length; i < 10; i++) {
                const col = i % 5;
                const row = Math.floor(i / 5);
                choices.push({
                    id: `f${entry.floorNumber}-room-${i + 1}-approx`,
                    label: `Room ${i + 1}`,
                    floorNumber: entry.floorNumber,
                    x: -width * 0.36 + col * (width * 0.18),
                    z: -depth * 0.24 + row * (depth * 0.48),
                    y: (entry.floorNumber - 1) * floorHeight + 0.12,
                    approximate: true
                });
            }
            roomChoicesByFloor.set(entry.floorNumber, choices);
        });

        function populateRoomSelect(select, floorValue, preferredIndex = 0) {
            const floorNo = Number(floorValue);
            const choices = roomChoicesByFloor.get(floorNo) || [];
            select.innerHTML = choices.map((room, index) =>
                `<option value="${escapeHTML(room.id)}">${escapeHTML(room.label.replace(/^F\d+ · /, ""))}</option>`
            ).join("");
            if (choices.length) select.selectedIndex = Math.min(preferredIndex, choices.length - 1);
        }
        populateRoomSelect(startRoomSelect, startFloorSelect.value, 0);
        populateRoomSelect(endRoomSelect, endFloorSelect.value, 1);
        startFloorSelect.addEventListener("change", () => populateRoomSelect(startRoomSelect, startFloorSelect.value, 0));
        endFloorSelect.addEventListener("change", () => populateRoomSelect(endRoomSelect, endFloorSelect.value, 0));

        function setRoutePanelHidden(hidden) {
            routePanel.classList.toggle("is-hidden", hidden);
            routeShowButton.style.display = hidden ? "block" : "none";
        }
        routePanel.querySelector("#routeHideButton").addEventListener("click", () => setRoutePanelHidden(true));
        routeShowButton.addEventListener("click", () => setRoutePanelHidden(false));

        function clearRoute() {
            while (routeObjects.children.length) {
                const object = routeObjects.children[0];
                routeObjects.remove(object);
                object.geometry?.dispose?.();
                if (Array.isArray(object.material)) object.material.forEach(m => m.dispose?.());
                else object.material?.dispose?.();
            }
        }
        function addRouteTube(points, color = 0x38d9c2, radius = 0.055, opacity = 1) {
            if (points.length < 2) return;
            const curve = new THREE.CatmullRomCurve3(points);
            const mesh = new THREE.Mesh(
                new THREE.TubeGeometry(curve, Math.max(32, points.length * 16), radius, 12, false),
                new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity })
            );
            routeObjects.add(mesh);
        }
        function addDirectionArrow(pointA, pointB, color = 0xeaffff) {
            const direction = new THREE.Vector3().subVectors(pointB, pointA);
            if (direction.length() < 0.001) return;
            direction.normalize();
            const arrow = new THREE.Mesh(
                new THREE.ConeGeometry(0.13, 0.34, 12),
                new THREE.MeshBasicMaterial({ color })
            );
            arrow.position.copy(pointA).add(pointB).multiplyScalar(0.5);
            arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
            routeObjects.add(arrow);
        }
        routePanel.querySelector("#clearRouteButton").addEventListener("click", () => {
            clearRoute();
            routePanel.querySelector("#routeStatus").textContent = "Route cleared. Choose another destination.";
        });
        routePanel.querySelector("#showRouteButton").addEventListener("click", () => {
            clearRoute();
            const from = (roomChoicesByFloor.get(Number(startFloorSelect.value)) || []).find(room => room.id === startRoomSelect.value);
            const to = (roomChoicesByFloor.get(Number(endFloorSelect.value)) || []).find(room => room.id === endRoomSelect.value);
            if (!from || !to || from.id === to.id && from.floorNumber === to.floorNumber) {
                routePanel.querySelector("#routeStatus").textContent = "Choose two different locations.";
                return;
            }

            const startY = from.y + 0.18;
            const endY = to.y + 0.18;
            const connectorChoice = routePanel.querySelector("#routeConnector").value;
            const isLift = connectorChoice.startsWith("lift");
            const isNorth = connectorChoice.endsWith("north");
            const connectorZ = isNorth ? -fd * 0.43 : fd * 0.43;
            const connectorX = isNorth ? -fw * 0.32 : fw * 0.32;
            const connectorBase = new THREE.Vector3(connectorX, startY, connectorZ);
            const connectorTop = new THREE.Vector3(connectorX, endY, connectorZ);
            // Find a corridor/free-space path on the selected blueprint floor.
            // A* runs over the image-derived walkability mask, avoiding detected wall pixels.
            function blueprintPath(entry, start, goal, yLevel) {
                const nav = entry?.data?.navigation_grid;
                if (!nav?.cells?.length) return null;
                const rows = nav.rows || nav.cells.length, cols = nav.columns || nav.cells[0].length;
                const toCell = p => ({ x: Math.max(0, Math.min(cols - 1, Math.round((p.x / (Number(nav.width) || fw) + 0.5) * (cols - 1)))), y: Math.max(0, Math.min(rows - 1, Math.round((-p.z / (Number(nav.depth) || fd) + 0.5) * (rows - 1)))) });
                const nearestOpen = cell => {
                    if (nav.cells[cell.y]?.[cell.x]) return cell;
                    for (let radius = 1; radius < 9; radius++) for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
                        const x = cell.x + dx, y = cell.y + dy;
                        if (x >= 0 && y >= 0 && x < cols && y < rows && nav.cells[y]?.[x]) return {x,y};
                    }
                    return null;
                };
                const a = nearestOpen(toCell(start)), b = nearestOpen(toCell(goal));
                if (!a || !b) return null;
                const key = c => `${c.x},${c.y}`, heuristic = (u,v) => Math.hypot(u.x-v.x,u.y-v.y);
                const open = [a], came = new Map(), g = new Map([[key(a),0]]), closed = new Set();
                const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
                while (open.length) {
                    open.sort((u,v) => (g.get(key(u))+heuristic(u,b))-(g.get(key(v))+heuristic(v,b)));
                    const cur = open.shift(), ck = key(cur);
                    if (ck === key(b)) {
                        const cells = [cur]; let k = ck;
                        while (came.has(k)) { const prev = came.get(k); cells.unshift(prev); k = key(prev); }
                        const stride = Math.max(1, Math.floor(cells.length / 80));
                        return cells.filter((c,i) => i % stride === 0 || i === cells.length-1).map(c => new THREE.Vector3((c.x/(cols-1)-0.5)*(Number(nav.width)||fw), yLevel, -(c.y/(rows-1)-0.5)*(Number(nav.depth)||fd)));
                    }
                    closed.add(ck);
                    for (const [dx,dy] of dirs) {
                        const n={x:cur.x+dx,y:cur.y+dy}, nk=key(n);
                        if(n.x<0||n.y<0||n.x>=cols||n.y>=rows||!nav.cells[n.y]?.[n.x]||closed.has(nk)) continue;
                        const tentative=g.get(ck)+(dx&&dy?1.414:1);
                        if(tentative < (g.get(nk) ?? Infinity)){came.set(nk,cur);g.set(nk,tentative);if(!open.some(v=>key(v)===nk))open.push(n);}
                    }
                }
                return null;
            }
            const startEntry = floorModels.find(e => e.floorNumber === from.floorNumber);
            const endEntry = floorModels.find(e => e.floorNumber === to.floorNumber);
            const sameFloorPath = from.floorNumber === to.floorNumber ? blueprintPath(startEntry, from, to, startY) : null;
            if (from.floorNumber === to.floorNumber && (!sameFloorPath || sameFloorPath.length < 2)) {
                routePanel.querySelector("#routeStatus").textContent = "No continuous walkable path could be confirmed from this blueprint. Check the corridor/door markings or choose another room.";
                if (routeVoiceEnabled && "speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance("No continuous walkable path could be confirmed from this blueprint."));
                return;
            }
            let routePoints = sameFloorPath && sameFloorPath.length > 1 ? sameFloorPath : [
                new THREE.Vector3(from.x, startY, from.z),
                new THREE.Vector3((from.x + connectorX) / 2, startY, from.z),
                connectorBase
            ];
            if (from.floorNumber !== to.floorNumber) {
                if (isLift) {
                    routePoints.push(new THREE.Vector3(connectorX, (startY + endY) / 2, connectorZ));
                } else {
                    const floorSteps = Math.max(3, Math.abs(to.floorNumber - from.floorNumber) * 5);
                    for (let step = 1; step <= floorSteps; step++) {
                        const t = step / (floorSteps + 1);
                        routePoints.push(new THREE.Vector3(
                            connectorX + (step % 2 ? 0.34 : -0.34),
                            startY + (endY - startY) * t,
                            connectorZ + (step % 2 ? 0.24 : -0.24)
                        ));
                    }
                }
            }
            if (from.floorNumber !== to.floorNumber) {
                routePoints.push(
                    connectorTop,
                    new THREE.Vector3((to.x + connectorX) / 2, endY, connectorZ),
                    new THREE.Vector3(to.x, endY, to.z)
                );
                const destinationLeg = blueprintPath(endEntry, {x: connectorX, z: connectorZ}, to, endY);
                if (destinationLeg?.length > 1) routePoints.splice(routePoints.length - 3, 3, ...destinationLeg);
            }
            addRouteTube(routePoints, 0x16cdbb, 0.095, 0.22);
            addRouteTube(routePoints, 0x53f2dc, 0.047, 1);
            for (let i = 0; i < routePoints.length - 1; i += Math.max(1, Math.floor(routePoints.length / 5))) {
                addDirectionArrow(routePoints[i], routePoints[i + 1]);
            }

            const startMarker = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 18), new THREE.MeshBasicMaterial({ color: 0x42f5a7 }));
            startMarker.position.set(from.x, startY, from.z);
            const endMarker = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 18), new THREE.MeshBasicMaterial({ color: 0xffb84d }));
            endMarker.position.set(to.x, endY, to.z);
            routeObjects.add(startMarker, endMarker);

            if (from.floorNumber !== to.floorNumber) {
                const connectorHeight = Math.max(0.15, Math.abs(endY - startY));
                if (isLift) {
                    const shaft = new THREE.Mesh(
                        new THREE.BoxGeometry(0.65, connectorHeight, 0.65),
                        new THREE.MeshBasicMaterial({ color: 0x69aaff, transparent: true, opacity: 0.2, wireframe: true })
                    );
                    shaft.position.set(connectorX, (startY + endY) / 2, connectorZ);
                    routeObjects.add(shaft);
                } else {
                    const stairCount = Math.max(5, Math.abs(to.floorNumber - from.floorNumber) * 8);
                    for (let step = 0; step < stairCount; step++) {
                        const t = (step + 0.5) / stairCount;
                        const stair = new THREE.Mesh(
                            new THREE.BoxGeometry(0.75, 0.09, 0.34),
                            new THREE.MeshStandardMaterial({ color: 0x8db8d8, metalness: 0.35, roughness: 0.42, emissive: 0x173c55 })
                        );
                        stair.position.set(connectorX + (step % 2 ? 0.12 : -0.12), startY + (endY - startY) * t, connectorZ + (step % 2 ? 0.22 : -0.22));
                        routeObjects.add(stair);
                    }
                }
            }

            target.set((from.x + to.x) / 2, (from.y + to.y) / 2 + 0.8, (from.z + to.z) / 2);
            distance = Math.max(fw, fd, totalHeight, 10) * 1.3;
            updateCamera();
            const connectorText = from.floorNumber === to.floorNumber ? "same-floor route" : (isLift ? "via lift" : "via stairs");
            const approxText = from.approximate || to.approximate ? " · approximate room positions" : "";
            routePanel.querySelector("#routeStatus").textContent = `Floor ${from.floorNumber} · ${from.label.replace(/^F\d+ · /, "")} → Floor ${to.floorNumber} · ${to.label.replace(/^F\d+ · /, "")} · ${connectorText}${approxText}`;
            if (routeVoiceEnabled && "speechSynthesis" in window) {
                window.speechSynthesis.cancel();
                const spoken = `Start at floor ${from.floorNumber}, ${from.label.replace(/^F\d+ · /, "")}. Follow the highlighted route ${connectorText} to floor ${to.floorNumber}, ${to.label.replace(/^F\d+ · /, "")}.`;
                window.speechSynthesis.speak(new SpeechSynthesisUtterance(spoken));
            }
        });

        let routeVoiceEnabled = false;
        const routeVoiceButton = routePanel.querySelector("#routeVoiceButton");
        routeVoiceButton.addEventListener("click", () => {
            routeVoiceEnabled = !routeVoiceEnabled;
            routeVoiceButton.textContent = routeVoiceEnabled ? "🔊 Voice guidance: On" : "🔊 Voice guidance: Off";
            routeVoiceButton.setAttribute("aria-pressed", String(routeVoiceEnabled));
            if (!routeVoiceEnabled && "speechSynthesis" in window) window.speechSynthesis.cancel();
            if (routeVoiceEnabled) {
                if (!("speechSynthesis" in window)) { routePanel.querySelector("#routeStatus").textContent = "Voice guidance is not supported by this browser."; routeVoiceEnabled = false; routeVoiceButton.textContent = "🔊 Voice guidance: Off"; return; }
                const msg = new SpeechSynthesisUtterance("Voice guidance enabled. Select your start and destination, then show route.");
                msg.rate = 0.95; window.speechSynthesis.speak(msg);
            }
        });

        if (floorModels.length < 2) {
            routePanel.querySelector("#routeConnector").disabled = true;
            routePanel.querySelector("#routeStatus").textContent = "Single-floor project · add another floor to enable stairs and lift routing.";
        }

        // Camera presets stay inside the 3D workspace and do not replace existing mouse controls.
        const viewControls = document.createElement("div");
        viewControls.className = "archnova-view-controls";
        viewControls.innerHTML = `<button type="button" data-view="3d">3D</button><button type="button" data-view="top">Top</button><button type="button" data-view="front">Front</button><button type="button" data-view="reset">Reset</button>`;
        viewer.appendChild(viewControls);
        viewControls.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
            const view = button.dataset.view;
            if (view === "top") { rotationX = 1.15; rotationY = 0.1; }
            else if (view === "front") { rotationX = 0.05; rotationY = 0; }
            else { rotationX = 0.5; rotationY = 0.7; }
            if (view === "reset") {
                target.set(0, totalHeight / 2, 0);
                distance = Math.max(fw, fd, totalHeight, 10) * 1.65;
            }
            updateCamera();
        }));

        function animate() {
            animationFrame = requestAnimationFrame(animate);
            renderer.render(scene, camera);
        }

        animate();

        resizeHandler = () => {
            if (!renderer) return;

            const w = viewer.clientWidth || 800;
            const h = viewer.clientHeight || 500;

            camera.aspect = w / h;
            camera.updateProjectionMatrix();

            renderer.setSize(w, h);
        };

        window.addEventListener("resize", resizeHandler);

        console.log("ARCHNOVA model loaded", {
            floors: floorModels.length,
            walls: floorModels.reduce((n, item) => n + (item.data.walls || []).length, 0),
            rooms: roomLocations.length,
            doors: floorModels.reduce((n, item) => n + (item.data.doors || []).length, 0),
            windows: floorModels.reduce((n, item) => n + (item.data.windows || []).length, 0)
        });

    } catch (error) {
        clear3DViewer();

        viewer.innerHTML = `
            <div class="viewer-empty">
                <h3>3D reconstruction failed</h3>
                <p>${escapeHTML(error.message)}</p>
            </div>
        `;

        console.error("ARCHNOVA 3D error:", error);
    }
};

// Sidebar navigation
document.querySelectorAll('.nav[href="#upload"]').forEach(link => {
    link.addEventListener("click", e => {
        e.preventDefault();
        window.openUpload();
    });
});

document.querySelectorAll('.nav[href="#projects"]').forEach(link => {
    link.addEventListener("click", e => {
        e.preventDefault();

        $("projects")?.scrollIntoView({
            behavior: "smooth"
        });
    });
});

document.querySelectorAll('.nav[href="#viewer"]').forEach(link => {
    link.addEventListener("click", e => {
        e.preventDefault();

        $("viewer")?.scrollIntoView({
            behavior: "smooth"
        });
    });
});

// Load projects when the page opens
window.loadProjects();
// ARCHNOVA AI Assistant - Groq Integration
(() => {
    const toggle = document.getElementById("aiAssistantToggle");
    const panel = document.getElementById("aiChatPanel");
    const close = document.getElementById("aiChatClose");
    const form = document.getElementById("aiChatForm");
    const input = document.getElementById("aiChatInput");
    const messages = document.getElementById("aiChatMessages");

    if (!toggle || !panel || !form) return;

    const history = [];

    toggle.addEventListener("click", () => {
        panel.classList.toggle("open");
    });

    close.addEventListener("click", () => {
        panel.classList.remove("open");
    });

    function addMessage(text, type) {
        const message = document.createElement("div");
        message.className = `ai-message ${type}`;
        message.textContent = text;
        messages.appendChild(message);
        messages.scrollTop = messages.scrollHeight;
        return message;
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const question = input.value.trim();
        if (!question) return;

        addMessage(question, "ai-user");
        input.value = "";
        input.disabled = true;

        const loading = addMessage("Thinking...", "ai-bot");

        history.push({
            role: "user",
            content: question
        });

        try {
            const response = await fetch("/api/groq/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    messages: [
                        {
                            role: "system",
                            content: "You are ARCHNOVA AI, an architectural assistant. Help users understand architecture, blueprints, floor plans, rooms, buildings and 3D reconstruction. Be clear and practical. Do not claim to see a blueprint or project unless its data is provided."
                        },
                        ...history
                    ]
                })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.detail || "AI request failed.");
            }

            loading.textContent = result.reply;
            history.push({
                role: "assistant",
                content: result.reply
            });

        } catch (error) {
            loading.textContent = "Error: " + error.message;
            history.pop();
            console.error("ARCHNOVA AI error:", error);
        } finally {
            input.disabled = false;
            input.focus();
            messages.scrollTop = messages.scrollHeight;
        }
    });
})();
// ==========================================
// ARCHNOVA - LIVE BLUETOOTH DEVICE MONITOR
// ==========================================

async function updateBluetoothMonitor() {
    try {
        const response = await fetch("/api/ble/status");

        if (!response.ok) {
            throw new Error("Bluetooth API unavailable");
        }

        const data = await response.json();

        document.getElementById("bleConnectionStatus").textContent =
            data.monitoring ? "MONITOR ACTIVE" : "MONITOR STOPPED";

        document.getElementById("bleTotalDevices").textContent =
            data.total_phones;

        const onlineCount = data.phones.filter(
            phone => phone.status === "Online"
        ).length;

        document.getElementById("bleOnlineDevices").textContent =
            onlineCount;

        document.getElementById("bleMonitorStatus").textContent =
            data.monitoring ? "ACTIVE" : "STOPPED";

        const deviceList = document.getElementById("bleDeviceList");

        deviceList.innerHTML = data.phones.map(phone => {
            const online = phone.status === "Online";

            // Convert RSSI into a display percentage.
            const signal = phone.rssi === null
                ? 0
                : Math.max(0, Math.min(
                    100,
                    ((phone.rssi + 100) / 60) * 100
                ));

            return `
                <div class="ble-device-card">
                    <h3>${phone.name}</h3>

                    <div class="ble-device-name">
                        ${phone.advertised_name}
                    </div>

                    <div class="ble-device-details">
                        <span class="ble-rssi">
                            ${phone.rssi !== null
                                ? phone.rssi + " dBm"
                                : "-- dBm"}
                        </span>

                        <span class="ble-status ${online
                            ? "online"
                            : "offline"}">
                            ${phone.status.toUpperCase()}
                        </span>
                    </div>

                    <div class="ble-signal-track">
                        <div class="ble-signal-fill"
                             style="width: ${signal}%">
                        </div>
                    </div>
                </div>
            `;
        }).join("");

    } catch (error) {
        document.getElementById("bleConnectionStatus").textContent =
            "CONNECTION ERROR";

        console.error("ARCHNOVA Bluetooth:", error);
    }
}

// Refresh device readings every 2 seconds.
updateBluetoothMonitor();
setInterval(updateBluetoothMonitor, 2000);