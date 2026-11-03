
from pathlib import Path
import cv2
import numpy as np
import fitz


def blueprint_to_image(file_path: str) -> np.ndarray:
    """Convert PDF or image blueprint into a grayscale image."""

    path = Path(file_path)

    if path.suffix.lower() == ".pdf":
        document = fitz.open(path)
        page = document[0]
        pix = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
        image = np.frombuffer(pix.samples, dtype=np.uint8)
        image = image.reshape(pix.height, pix.width, pix.n)
        image = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        document.close()
        return image

    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)

    if image is None:
        raise ValueError("Unable to read blueprint")

    return image


def detect_walls(image: np.ndarray):
    """Detect wall-like lines using image processing."""

    blurred = cv2.GaussianBlur(image, (3, 3), 0)

    binary = cv2.adaptiveThreshold(
        blurred,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        10
    )

    horizontal_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (25, 1)
    )

    vertical_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (1, 25)
    )

    horizontal = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN, horizontal_kernel
    )

    vertical = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN, vertical_kernel
    )

    walls = cv2.bitwise_or(horizontal, vertical)

    return walls


def reconstruct_blueprint(file_path: str):
    """Create a first-pass reconstruction geometry."""

    image = blueprint_to_image(file_path)
    walls = detect_walls(image)

    contours, _ = cv2.findContours(
        walls,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE
    )

    wall_geometry = []

    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)

        if width < 10 and height < 10:
            continue

        wall_geometry.append({
            "x": int(x),
            "y": int(y),
            "width": int(width),
            "height": int(height),
            "wall_height": 3.0
        })

    return {
        "image_width": int(image.shape[1]),
        "image_height": int(image.shape[0]),
        "wall_count": len(wall_geometry),
        "walls": wall_geometry
    }

