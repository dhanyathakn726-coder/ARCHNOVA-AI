from pathlib import Path
import sqlite3
import uuid
import json
import math
import os
from groq import Groq
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

import cv2
import numpy as np
import fitz
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
try:
    from .reconstruction_v2 import reconstruct_blueprint_v2
except ImportError:
    from reconstruction_v2 import reconstruct_blueprint_v2
try:
    from .ble_monitor import (
        start_ble_monitor,
        stop_ble_monitor,
        get_ble_status
    )
except ImportError:
    from ble_monitor import (
        start_ble_monitor,
        stop_ble_monitor,
        get_ble_status
    )

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
STORAGE_DIR = BASE_DIR / "storage"
BLUEPRINT_DIR = STORAGE_DIR / "blueprints"
MODEL_DIR = STORAGE_DIR / "models"
DB_PATH = STORAGE_DIR / "archnova.db"

BLUEPRINT_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="ARCHNOVA AI")
class GroqChatRequest(BaseModel):
    messages: list[dict]


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                filename TEXT NOT NULL,
                blueprint_path TEXT NOT NULL,
                status TEXT NOT NULL
            )
        """)


init_db()

# Multi-floor storage is additive: existing project/model records remain unchanged.
with sqlite3.connect(DB_PATH) as _conn:
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS project_floors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            floor_number INTEGER NOT NULL,
            filename TEXT NOT NULL,
            blueprint_path TEXT NOT NULL,
            model_path TEXT NOT NULL,
            UNIQUE(project_id, floor_number)
        )
    """)


def blueprint_to_image(file_path):
    file_path = Path(file_path)
    if file_path.suffix.lower() == ".pdf":
        document = fitz.open(file_path)
        try:
            pixmap = document[0].get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
            image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, pixmap.n
            )
            return cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        finally:
            document.close()

    image = cv2.imread(str(file_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Could not read blueprint image")
    return image


def merge_intervals(intervals, gap=0):
    if not intervals:
        return []
    values = sorted((min(int(a), int(b)), max(int(a), int(b))) for a, b in intervals)
    result = [list(values[0])]
    for start, end in values[1:]:
        if start <= result[-1][1] + gap:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([start, end])
    return [(a, b) for a, b in result if b > a]


def detect_axis_lines(binary, width, height):
    """Extract long horizontal/vertical strokes and retain likely gaps as openings."""
    min_dim = min(width, height)
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(18, width // 35), 1))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(18, height // 35)))
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel)

    lines = []
    for axis, mask in (("h", horizontal), ("v", vertical)):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if axis == "h" and w >= max(24, min_dim * 0.035) and w >= h * 3:
                lines.append((axis, y + h / 2, x, x + w, max(3, h)))
            elif axis == "v" and h >= max(24, min_dim * 0.035) and h >= w * 3:
                lines.append((axis, x + w / 2, y, y + h, max(3, w)))

    # Group nearly collinear strokes. Gaps between strokes can be door/window candidates.
    grouped = []
    tolerance = max(5, int(min_dim * 0.008))
    for axis in ("h", "v"):
        subset = sorted([v for v in lines if v[0] == axis], key=lambda v: v[1])
        clusters = []
        for line in subset:
            if clusters and abs(line[1] - np.mean([v[1] for v in clusters[-1]])) <= tolerance:
                clusters[-1].append(line)
            else:
                clusters.append([line])

        for cluster in clusters:
            fixed = float(np.mean([v[1] for v in cluster]))
            thickness = float(np.median([v[4] for v in cluster]))
            spans = sorted((v[2], v[3]) for v in cluster)
            # Join close fragments as a continuous wall, but preserve architectural-sized gaps.
            joined = [list(spans[0])]
            for a, b in spans[1:]:
                gap = a - joined[-1][1]
                if gap <= max(5, int(min_dim * 0.012)):
                    joined[-1][1] = max(joined[-1][1], b)
                else:
                    joined.append([a, b])

            # Candidate openings are gaps between aligned wall fragments.
            for left, right in zip(joined, joined[1:]):
                gap = right[0] - left[1]
                if max(12, min_dim * 0.018) <= gap <= max(75, min_dim * 0.13):
                    grouped.append({
                        "axis": axis, "fixed": fixed,
                        "start": float(left[1]), "end": float(right[0]),
                        "thickness_px": thickness, "is_gap": True
                    })
            for a, b in joined:
                grouped.append({
                    "axis": axis, "fixed": fixed,
                    "start": float(a), "end": float(b),
                    "thickness_px": thickness, "is_gap": False
                })
    return grouped, cv2.bitwise_or(horizontal, vertical)


def reconstruct_blueprint(file_path):
    image = cv2.GaussianBlur(blueprint_to_image(file_path), (3, 3), 0)
    binary = cv2.adaptiveThreshold(
        image, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 31, 7
    )
    height, width = binary.shape
    if min(width, height) < 100:
        raise ValueError("Blueprint image is too small to reconstruct")

    detections, wall_mask = detect_axis_lines(binary, width, height)
    scale = 25.0 / max(width, height)
    walls, openings = [], []

    for item in detections:
        axis, fixed = item["axis"], item["fixed"]
        a, b = item["start"], item["end"]
        if item["is_gap"]:
            gap_px = b - a
            opening_type = "door" if gap_px * scale >= 0.85 else "window"
            center_px = (a + b) / 2
            if axis == "h":
                center = [(center_px - width / 2) * scale,
                          -(fixed - height / 2) * scale]
                orientation = "horizontal"
            else:
                center = [(fixed - width / 2) * scale,
                          -(center_px - height / 2) * scale]
                orientation = "vertical"
            openings.append({
                "type": opening_type, "center": center,
                "width": max(0.45, gap_px * scale),
                "wall_axis": orientation
            })
            continue

        if b - a < 6:
            continue
        if axis == "h":
            start = [(a - width / 2) * scale, -(fixed - height / 2) * scale]
            end = [(b - width / 2) * scale, -(fixed - height / 2) * scale]
        else:
            start = [(fixed - width / 2) * scale, -(a - height / 2) * scale]
            end = [(fixed - width / 2) * scale, -(b - height / 2) * scale]
        walls.append({
            "start": start, "end": end,
            "thickness": max(0.10, item["thickness_px"] * scale),
            "height": 3.0, "kind": "wall"
        })

    # Remove duplicate opening guesses from overlapping wall detections.
    unique_openings = []
    for opening in openings:
        x, z = opening["center"]
        if not any(o["type"] == opening["type"] and
                   math.hypot(x - o["center"][0], z - o["center"][1]) < 0.35
                   for o in unique_openings):
            unique_openings.append(opening)

    # Approximate enclosed compartments by connected-component analysis.
    barriers = cv2.dilate(wall_mask, np.ones((3, 3), np.uint8), iterations=2)
    free_space = cv2.bitwise_not(barriers)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        free_space, connectivity=8
    )
    rooms = []
    min_area = max(500, int(width * height * 0.0015))
    for label in range(1, count):
        x, y, w, h, area = stats[label]
        if x <= 1 or y <= 1 or x + w >= width - 1 or y + h >= height - 1:
            continue
        if area < min_area or area > width * height * 0.45 or w < 20 or h < 20:
            continue
        cx, cy = centroids[label]
        rooms.append({
            "id": f"room-{len(rooms) + 1}",
            "name": f"Room {len(rooms) + 1}",
            "center": [(cx - width / 2) * scale, -(cy - height / 2) * scale],
            "width": w * scale,
            "depth": h * scale,
            "area": round(area * scale * scale, 2)
        })
    rooms.sort(key=lambda room: room["area"], reverse=True)
    rooms = rooms[:30]

    doors = [o for o in unique_openings if o["type"] == "door"]
    windows = [o for o in unique_openings if o["type"] == "window"]

    return {
        "image_width": width,
        "image_height": height,
        "walls": walls,
        "wall_count": len(walls),
        "doors": doors,
        "door_count": len(doors),
        "windows": windows,
        "window_count": len(windows),
        "rooms": rooms,
        "room_count": len(rooms),
        "floor": {
            "width": width * scale,
            "depth": height * scale,
            "thickness": 0.15
        },
        "units": "normalized_model_units",
        "reconstruction_type": "heuristic_architectural_reconstruction",
        "accuracy_note": (
            "Approximate reconstruction from 2D line patterns. Door, window and "
            "room detection can be incomplete or misclassified; verify against "
            "the uploaded blueprint."
        )
    }


@app.get("/api/health")
def health():
    return {"status": "healthy", "application": "ARCHNOVA AI"}
@app.on_event("startup")
async def start_archnova_ble():
    try:
        await start_ble_monitor()
    except Exception as error:
        print(f"BLE Monitor could not start: {error}")


@app.on_event("shutdown")
async def stop_archnova_ble():
    try:
        await stop_ble_monitor()
    except Exception as error:
        print(f"BLE Monitor shutdown error: {error}")


@app.get("/api/ble/status")
def ble_status():
    return get_ble_status()


@app.get("/api/projects")
def get_projects():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM projects ORDER BY rowid DESC").fetchall()
    return [
        {"id": r["id"], "name": r["name"], "filename": r["filename"], "status": r["status"]}
        for r in rows
    ]


@app.post("/api/projects")
async def create_project(name: str, blueprint: UploadFile = File(...)):
    extension = Path(blueprint.filename or "").suffix.lower()
    if extension not in {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff"}:
        raise HTTPException(400, "Upload PDF, PNG, JPG or TIFF blueprint")
    project_id = str(uuid.uuid4())
    filename = Path(blueprint.filename).name
    blueprint_path = BLUEPRINT_DIR / f"{project_id}{extension}"
    model_path = MODEL_DIR / f"{project_id}.json"
    content = await blueprint.read()
    if not content:
        raise HTTPException(400, "Uploaded blueprint is empty")
    if len(content) > 25 * 1024 * 1024:
        raise HTTPException(413, "Blueprint must be 25 MB or smaller")
    blueprint_path.write_bytes(content)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """INSERT INTO projects
            (id, name, filename, blueprint_path, status)
            VALUES (?, ?, ?, ?, ?)""",
            (project_id, name, filename, str(blueprint_path), "Processing")
        )

    try:
        model = reconstruct_blueprint_v2(blueprint_path)
        model.update({"project_id": project_id, "project_name": name})
        model_path.write_text(json.dumps(model, indent=2), encoding="utf-8")
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """INSERT OR REPLACE INTO project_floors
                (project_id, floor_number, filename, blueprint_path, model_path)
                VALUES (?, 1, ?, ?, ?)""",
                (project_id, filename, str(blueprint_path), str(model_path))
            )
            conn.execute("UPDATE projects SET status=? WHERE id=?",
                         ("3D Generated", project_id))
        return {
            "id": project_id, "name": name, "filename": filename,
            "status": "3D Generated", "wall_count": model["wall_count"],
            "door_count": model["door_count"], "window_count": model["window_count"],
            "room_count": model["room_count"],
            "model_url": f"/api/projects/{project_id}/model",
            "accuracy_note": model["accuracy_note"]
        }
    except Exception as error:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("UPDATE projects SET status=? WHERE id=?",
                         ("Failed", project_id))
        raise HTTPException(500, f"3D reconstruction failed: {error}")


@app.get("/api/projects/{project_id}/model")
def get_model(project_id: str, floor: int = 1):
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT model_path FROM project_floors WHERE project_id=? AND floor_number=?",
            (project_id, floor)
        ).fetchone()
        floors = conn.execute(
            "SELECT floor_number, filename FROM project_floors WHERE project_id=? ORDER BY floor_number",
            (project_id,)
        ).fetchall()
    # Backward compatibility for projects created before multi-floor support.
    path = Path(row[0]) if row else MODEL_DIR / f"{project_id}.json"
    if not path.exists():
        raise HTTPException(404, "3D model not generated for this floor")
    model = json.loads(path.read_text(encoding="utf-8"))
    model["floor_number"] = floor if row else 1
    model["available_floors"] = [
        {"floor_number": item[0], "filename": item[1]} for item in floors
    ] or [{"floor_number": 1, "filename": "Blueprint"}]
    return model


@app.post("/api/projects/{project_id}/floors")
async def add_project_floor(
    project_id: str,
    blueprint: UploadFile = File(None),
    duplicate_existing: bool = False
):
    with sqlite3.connect(DB_PATH) as conn:
        project = conn.execute("SELECT id, filename, blueprint_path FROM projects WHERE id=?", (project_id,)).fetchone()
        rows = conn.execute(
            "SELECT floor_number, blueprint_path, model_path, filename FROM project_floors WHERE project_id=? ORDER BY floor_number",
            (project_id,)
        ).fetchall()
        if project and not rows:
            legacy_model = MODEL_DIR / f"{project_id}.json"
            if legacy_model.exists():
                conn.execute(
                    """INSERT OR IGNORE INTO project_floors
                    (project_id, floor_number, filename, blueprint_path, model_path)
                    VALUES (?, 1, ?, ?, ?)""",
                    (project_id, project[1], project[2], str(legacy_model))
                )
                rows = [(1, project[2], str(legacy_model), project[1])]
    if not project:
        raise HTTPException(404, "Project not found")
    if not rows:
        raise HTTPException(404, "The project has no base floor model")
    next_floor = max(row[0] for row in rows) + 1
    if duplicate_existing:
        source = next((r for r in rows if r[0] == 1), rows[0])
        source_model = json.loads(Path(source[2]).read_text(encoding="utf-8"))
        filename = source[3]
        blueprint_path = Path(source[1])
        model_path = MODEL_DIR / f"{project_id}-floor-{next_floor}.json"
        source_model["floor_number"] = next_floor
        source_model["project_id"] = project_id
        model_path.write_text(json.dumps(source_model, indent=2), encoding="utf-8")
    else:
        if not blueprint or not blueprint.filename:
            raise HTTPException(400, "Choose a blueprint for this floor or select duplicate existing blueprint.")
        extension = Path(blueprint.filename).suffix.lower()
        if extension not in {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff"}:
            raise HTTPException(400, "Upload PDF, PNG, JPG or TIFF blueprint")
        content = await blueprint.read()
        if not content or len(content) > 25 * 1024 * 1024:
            raise HTTPException(400, "Blueprint must be non-empty and 25 MB or smaller")
        filename = Path(blueprint.filename).name
        blueprint_path = BLUEPRINT_DIR / f"{project_id}-floor-{next_floor}{extension}"
        blueprint_path.write_bytes(content)
        model_path = MODEL_DIR / f"{project_id}-floor-{next_floor}.json"
        try:
            model = reconstruct_blueprint_v2(blueprint_path)
            model.update({"project_id": project_id, "floor_number": next_floor})
            model_path.write_text(json.dumps(model, indent=2), encoding="utf-8")
        except Exception as error:
            raise HTTPException(500, f"Floor reconstruction failed: {error}")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """INSERT INTO project_floors
            (project_id, floor_number, filename, blueprint_path, model_path)
            VALUES (?, ?, ?, ?, ?)""",
            (project_id, next_floor, filename, str(blueprint_path), str(model_path))
        )
    return {"project_id": project_id, "floor_number": next_floor, "filename": filename, "status": "3D Generated"}


@app.get("/api/projects/{project_id}/blueprint")
def get_blueprint(project_id: str):
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT blueprint_path FROM projects WHERE id=?",
                           (project_id,)).fetchone()
    if not row or not Path(row[0]).exists():
        raise HTTPException(404, "Project not found")
    return FileResponse(row[0])


@app.get("/")
def homepage():
    index = FRONTEND_DIR / "index.html"
    if not index.exists():
        raise HTTPException(500, "frontend/index.html is missing")
    return FileResponse(index)

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row

        project = conn.execute(
            "SELECT * FROM projects WHERE id = ?",
            (project_id,)
        ).fetchone()

        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        floors = conn.execute(
            """SELECT blueprint_path, model_path
               FROM project_floors
               WHERE project_id = ?""",
            (project_id,)
        ).fetchall()

        paths = {
            project["blueprint_path"],
            str(MODEL_DIR / f"{project_id}.json")
        }

        for floor in floors:
            paths.add(floor["blueprint_path"])
            paths.add(floor["model_path"])

        conn.execute(
            "DELETE FROM project_floors WHERE project_id = ?",
            (project_id,)
        )

        conn.execute(
            "DELETE FROM projects WHERE id = ?",
            (project_id,)
        )

    for file_path in paths:
        if file_path and Path(file_path).exists():
            Path(file_path).unlink()

    return {"message": "Project deleted successfully"}
@app.post("/api/groq/chat")
def groq_chat(request: GroqChatRequest):

    api_key = os.getenv("GROQ_API_KEY")

    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is not configured"
        )

    if not request.messages or len(request.messages) > 20:
        raise HTTPException(
            status_code=400,
            detail="Provide between 1 and 20 messages"
        )

    for message in request.messages:
        if (
            message.get("role") not in ["system", "user", "assistant"]
            or not isinstance(message.get("content"), str)
        ):
            raise HTTPException(
                status_code=400,
                detail="Invalid chat message format"
            )

    try:
        client = Groq(api_key=api_key)

        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=request.messages
        )

        return {
            "success": True,
            "reply": completion.choices[0].message.content
        }

    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Groq API error: {str(error)}"
        )
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")
