"""Improved blueprint-to-3D geometry extraction for ARCHNOVA AI.

This module deliberately keeps the existing API/model schema so the current
Three.js viewer and UI continue to work without redesign.
"""
from pathlib import Path
import hashlib

import cv2
import fitz
import numpy as np


def _read_blueprint(file_path):
    path = Path(file_path)
    if path.suffix.lower() == ".pdf":
        with fitz.open(path) as document:
            if not len(document):
                raise ValueError("The uploaded PDF has no pages")
            pix = document[0].get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n
            )
            return cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)

    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Could not read the uploaded blueprint image")
    return image


def _extract_thick_axis_segments(binary, width, height):
    """Keep substantial architectural strokes; reject most text/furniture lines."""
    min_dim = min(width, height)
    kernel_len = max(12, int(min_dim * 0.028))
    min_length = max(24, int(min_dim * 0.035))
    segments = []
    combined = np.zeros_like(binary)

    for axis, kernel_size in (
        ("h", (kernel_len, 1)),
        ("v", (1, kernel_len)),
    ):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, kernel_size)
        mask = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
        combined = cv2.bitwise_or(combined, mask)
        contours, _ = cv2.findContours(
            mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            length = w if axis == "h" else h
            thickness = h if axis == "h" else w
            # Architectural wall strokes are substantially thicker than most
            # furniture, labels and dimension annotations in raster plans.
            if length < min_length or length < thickness * 3 or thickness < 8:
                continue
            if axis == "h":
                segments.append((axis, y + h / 2, x, x + w, thickness))
            else:
                segments.append((axis, x + w / 2, y, y + h, thickness))

    return segments, combined


def _cluster_segments(segments, axis, tolerance, join_gap):
    selected = sorted((s for s in segments if s[0] == axis), key=lambda s: s[1])
    clusters = []
    for segment in selected:
        if clusters and abs(segment[1] - np.mean([v[1] for v in clusters[-1]])) <= tolerance:
            clusters[-1].append(segment)
        else:
            clusters.append([segment])

    result = []
    for cluster in clusters:
        fixed = float(np.mean([v[1] for v in cluster]))
        thickness = float(np.median([v[4] for v in cluster]))
        spans = sorted((v[2], v[3]) for v in cluster)
        merged = [list(spans[0])]
        for start, end in spans[1:]:
            if start - merged[-1][1] <= join_gap:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        for start, end in merged:
            if end - start >= 8:
                result.append((axis, fixed, float(start), float(end), thickness))
    return result


def reconstruct_blueprint_v2(file_path):
    """Create blueprint-specific walls, openings and room regions."""
    path = Path(file_path)
    image = _read_blueprint(path)
    image = cv2.GaussianBlur(image, (3, 3), 0)
    height, width = image.shape
    if min(width, height) < 100:
        raise ValueError("Blueprint image is too small to reconstruct")

    # A fixed high-contrast threshold preserves thick wall marks while reducing
    # pale furniture, text and background details that clutter the 3D output.
    _, binary = cv2.threshold(image, 210, 255, cv2.THRESH_BINARY_INV)
    segments, initial_wall_mask = _extract_thick_axis_segments(binary, width, height)
    min_dim = min(width, height)
    tolerance = max(4, int(min_dim * 0.006))
    join_gap = max(4, int(min_dim * 0.006))

    lines = []
    for axis in ("h", "v"):
        lines.extend(_cluster_segments(segments, axis, tolerance, join_gap))

    if len(lines) < 4:
        raise ValueError(
            "Not enough clear wall lines were detected. Upload a higher-resolution "
            "floor plan with visible wall outlines."
        )

    # Crop model bounds to the detected plan, rather than the full image/page.
    xs, ys = [], []
    for axis, fixed, start, end, _ in lines:
        if axis == "h":
            xs.extend((start, end)); ys.append(fixed)
        else:
            xs.append(fixed); ys.extend((start, end))
    pad = max(8, int(min_dim * 0.018))
    left = max(0.0, min(xs) - pad)
    right = min(float(width), max(xs) + pad)
    top = max(0.0, min(ys) - pad)
    bottom = min(float(height), max(ys) + pad)
    plan_width = max(1.0, right - left)
    plan_height = max(1.0, bottom - top)
    scale = 25.0 / max(plan_width, plan_height)

    def point(x, y):
        return [round((x - (left + right) / 2) * scale, 4),
                round(-((y - (top + bottom) / 2) * scale), 4)]

    walls = []
    for axis, fixed, start, end, thickness_px in lines:
        if axis == "h":
            start_point, end_point = point(start, fixed), point(end, fixed)
        else:
            start_point, end_point = point(fixed, start), point(fixed, end)
        walls.append({
            "start": start_point,
            "end": end_point,
            "thickness": round(max(0.10, thickness_px * scale), 3),
            "height": 3.0,
            "kind": "wall",
        })

    # Estimate room regions with the original adaptive-threshold strategy, but
    # crop to the detected plan bounds and convert all coordinates into the
    # same blueprint-specific model coordinate system as the walls.
    adaptive = cv2.adaptiveThreshold(
        image, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 31, 7
    )
    h_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (max(18, width // 35), 1)
    )
    v_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (1, max(18, height // 35))
    )
    horizontal = cv2.morphologyEx(adaptive, cv2.MORPH_OPEN, h_kernel)
    vertical = cv2.morphologyEx(adaptive, cv2.MORPH_OPEN, v_kernel)
    legacy_wall_mask = cv2.bitwise_or(horizontal, vertical)
    crop = legacy_wall_mask[int(top):max(int(top) + 1, int(bottom)),
                            int(left):max(int(left) + 1, int(right))]
    barriers = cv2.dilate(crop, np.ones((3, 3), np.uint8), iterations=2)
    free_space = cv2.bitwise_not(barriers)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        free_space, connectivity=8
    )
    rooms = []
    crop_h, crop_w = crop.shape
    min_area = max(500, int(crop_w * crop_h * 0.0015))
    for label in range(1, count):
        x, y, w, h, area = stats[label]
        if x <= 1 or y <= 1 or x + w >= crop_w - 1 or y + h >= crop_h - 1:
            continue
        if area < min_area or area > crop_w * crop_h * 0.45 or w < 20 or h < 20:
            continue
        cx, cy = centroids[label]
        rooms.append({
            "id": f"room-{len(rooms) + 1}",
            "name": f"Room {len(rooms) + 1}",
            "center": point(left + cx, top + cy),
            "width": round(w * scale, 3),
            "depth": round(h * scale, 3),
            "area": round(area * scale * scale, 2),
        })
    rooms.sort(key=lambda room: room["area"], reverse=True)
    rooms = rooms[:30]

    # Openings are intentionally not fabricated from every gap: this avoids
    # turning furniture gaps and labels into false doors/windows.
    doors, windows = [], []
    digest = hashlib.sha256(path.read_bytes()).hexdigest()

    # Coarse walkable-space mask derived from the uploaded blueprint itself.
    # White/free pixels are candidate corridors and room interiors; wall strokes
    # are blocked. This is a navigation aid, not a guarantee of code-compliant paths.
    grid_size = 64
    walkable_grid = []
    for gy in range(grid_size):
        row = []
        py = min(crop_h - 1, max(0, int((gy + 0.5) * crop_h / grid_size)))
        for gx in range(grid_size):
            px = min(crop_w - 1, max(0, int((gx + 0.5) * crop_w / grid_size)))
            row.append(bool(free_space[py, px] > 0))
        walkable_grid.append(row)

    return {
        "image_width": int(width),
        "image_height": int(height),
        "walls": walls,
        "wall_count": len(walls),
        "doors": doors,
        "door_count": 0,
        "windows": windows,
        "window_count": 0,
        "rooms": rooms,
        "room_count": len(rooms),
        "navigation_grid": {
            "cells": walkable_grid,
            "columns": grid_size,
            "rows": grid_size,
            "width": round(plan_width * scale, 4),
            "depth": round(plan_height * scale, 4),
            "source": "blueprint_free_space_mask"
        },
        "floor": {
            "width": round(plan_width * scale, 3),
            "depth": round(plan_height * scale, 3),
            "thickness": 0.15,
        },
        "units": "normalized_model_units",
        "reconstruction_type": "blueprint_specific_thick_wall_reconstruction_v2",
        "source_sha256": digest,
        "source_filename": path.name,
        "accuracy_note": (
            "Blueprint-specific approximate reconstruction using detected thick wall "
            "strokes. Doors and windows are not guessed when the raster plan does not "
            "provide reliable opening evidence. Verify dimensions against the source plan."
        ),
    }
