import json
import os
import re
import threading
import time
import ctypes
from collections import deque
from queue import Empty, Full, Queue

from pynput import mouse
from pytesseract import TesseractError
from PIL import ImageChops, ImageStat

from logging_config import setup_logger
from data.chest_points_list import chest_category_aliases
from models.database import Chest
from models.database import get_session as DB_gs
from models.database import initialize_database
from scripts.ocr import OCR
from scripts.screenshot import grab_image
from scripts.textprocessing import TextProcessor

logger = setup_logger(__name__)


class Counter:
    """Record gift rows either from manual clicks or auto-open scanning."""

    def __init__(
        self,
        db_filename="chest_counter.db",
        auto_create_db=True,
        screenshot_error_show=True,
        show_notifications=False,
        auto_open=False,
        click_tolerance=18,
        duplicate_window_seconds=1.5,
        frame_interval_seconds=0.05,
        click_queue_size=60,
        worker_count=1,
        post_click_verify_seconds=0.0,
        auto_open_interval_seconds=0.05,
        auto_open_verify_seconds=0.12,
        action_button_search_timeout_seconds=0.30,
        action_button_poll_seconds=0.03,
        action_button_search_step=8,
    ):
        self.db_filename = db_filename
        self.db_path = os.path.join("storage", self.db_filename)
        self.screenshot_error_show = screenshot_error_show
        self.show_notifications = show_notifications
        self.auto_open = auto_open
        self.click_tolerance = click_tolerance
        self.duplicate_window_seconds = duplicate_window_seconds
        self.frame_interval_seconds = frame_interval_seconds
        self.click_queue_size = click_queue_size
        self.worker_count = max(1, worker_count)
        self.post_click_verify_seconds = post_click_verify_seconds
        self.auto_open_interval_seconds = auto_open_interval_seconds
        self.auto_open_verify_seconds = auto_open_verify_seconds
        self.action_button_search_timeout_seconds = action_button_search_timeout_seconds
        self.action_button_poll_seconds = action_button_poll_seconds
        self.action_button_search_step = action_button_search_step

        self._prepare_database(auto_create_db)
        self.ocr = OCR()
        self.source_aliases = sorted(
            chest_category_aliases.items(),
            key=lambda item: len(item[0]),
            reverse=True,
        )
        self.running = False
        self.listener = None
        self.last_saved = None
        self.state_lock = threading.Lock()
        self.frame_lock = threading.Lock()
        self.frame_history = deque(maxlen=6)
        self.frame_thread = None
        self.click_queue = Queue(maxsize=self.click_queue_size)
        self.worker_threads = []
        self.mouse_controller = mouse.Controller()
        self.user32 = ctypes.windll.user32 if os.name == "nt" else None
        self.last_auto_attempt = None
        self.auto_anchor = None
        self.last_action_button_bbox = None
        self.action_button_template = self._load_action_button_template()
        self.action_button_samples = self._build_template_samples(
            self.action_button_template
        )

    # -------------------------------------------------------------------------
    # DATABASE
    # -------------------------------------------------------------------------
    def _prepare_database(self, auto_create):
        """Ensure that the database exists."""
        if not os.path.isfile(self.db_path):
            if auto_create:
                initialize_database()
                logger.info("Database created successfully.")
            else:
                raise FileNotFoundError(f"Database {self.db_filename} not found.")

    # -------------------------------------------------------------------------
    # ENTRY POINT
    # -------------------------------------------------------------------------
    def start(self):
        """Start listening for manual clicks or auto-open visible chests."""
        self.running = True
        if self.auto_open:
            logger.info("Counter initialized. Auto-opening visible chests.")
        else:
            logger.info("Counter initialized. Click Open buttons manually to save rows.")

        if self.auto_open:
            while self.running:
                try:
                    self._auto_open_once()
                    time.sleep(self.auto_open_interval_seconds)
                except KeyboardInterrupt:
                    self.running = False
                except Exception as exc:
                    logger.error(f"Error in auto-open loop: {exc}", exc_info=True)
                    time.sleep(self.auto_open_interval_seconds)
            return

        self._capture_frame()
        self.frame_thread = threading.Thread(
            target=self._frame_loop,
            name="counter-frame-cache",
            daemon=True,
        )
        self.frame_thread.start()

        self.worker_threads = []
        for index in range(self.worker_count):
            worker_thread = threading.Thread(
                target=self._click_worker_loop,
                name=f"counter-click-worker-{index + 1}",
                daemon=True,
            )
            worker_thread.start()
            self.worker_threads.append(worker_thread)

        self.listener = mouse.Listener(on_click=self._on_click)
        self.listener.start()

        while self.running:
            try:
                time.sleep(0.2)
            except KeyboardInterrupt:
                self.running = False
            except Exception as exc:
                logger.error(f"Error in click listener loop: {exc}", exc_info=True)
                self._notify("ERROR", "Player: ERROR\nChest: Processing failed", 5)

    def _auto_open_once(self):
        _captured_at, screen = time.time(), grab_image()
        row = self._extract_row_from_anchor(screen)
        if not row:
            rows = self._find_rows(screen)
            row = self._select_auto_row(rows)
            if not row:
                return

        button = row["button"]
        if self._is_recent_auto_attempt(button):
            return

        self.last_auto_attempt = {
            "center_x": button["center_x"],
            "center_y": button["center_y"],
            "timestamp": time.time(),
        }

        if self._is_recent_duplicate(row):
            return

        row_text = row["text"]
        tp = TextProcessor(row_text)
        player_name = tp.get_player_name() or "Unknown"
        chest_name = tp.get_chest_name() or self._shorten_row_label(row_text)

        logger.info(
            "Auto-opening %s: %s at (%s, %s).",
            player_name,
            chest_name,
            button["center_x"],
            button["center_y"],
        )
        self._click_button(button["center_x"], button["center_y"])
        action_match = self._click_action_button_if_visible()
        if not action_match:
            return

        if not self._confirm_action_button_clicked(action_match):
            return

        if not self._save_row_text(row["text"], row["image"]):
            return

        self.last_saved = {
            "signature": row["signature"],
            "center_x": button["center_x"],
            "center_y": button["center_y"],
            "timestamp": time.time(),
        }
        self.auto_anchor = {
            "center_x": button["center_x"],
            "center_y": button["center_y"],
        }

    def _extract_row_from_anchor(self, screen):
        if not self.auto_anchor:
            return None

        button = self._find_local_button(
            screen,
            self.auto_anchor["center_x"],
            self.auto_anchor["center_y"],
            x_radius=80,
            y_radius=36,
            near_click_x_tolerance=26,
            near_click_y_tolerance=18,
            row_y_tolerance=30,
            min_near_green=70,
        )
        if not button:
            return None

        extracted = self._extract_row_from_button(screen, button)
        if not extracted:
            return None

        row_image, row_text = extracted
        return {
            "button": button,
            "image": row_image,
            "text": row_text,
            "signature": " ".join(row_text.split()).lower(),
        }

    def _get_latest_screen(self):
        with self.frame_lock:
            if self.frame_history:
                return self.frame_history[-1]
        fresh_screen = grab_image()
        return time.time(), fresh_screen

    def _select_auto_button(self, buttons):
        visible_buttons = [button for button in buttons if button["center_y"] >= 170]
        if not visible_buttons:
            return None
        visible_buttons.sort(key=lambda item: item["center_y"])
        return visible_buttons[0]

    def _select_auto_row(self, rows):
        visible_rows = [row for row in rows if row["button"]["center_y"] >= 170]
        if not visible_rows:
            return None
        visible_rows.sort(key=lambda item: item["button"]["center_y"])
        return visible_rows[0]

    def _find_auto_buttons(self, screen):
        width, height = screen.size
        search_left = max(0, max(int(width * 0.80), width - 220))
        search_right = min(width, max(search_left + 80, int(width * 0.98)))
        search_top = max(120, int(height * 0.12))
        search_bottom = min(height, int(height * 0.92))
        scan_width = max(1, search_right - search_left)
        buttons = []
        seed_x = min(width - 1, search_left + scan_width // 2)
        step_y = 18
        y = max(170, search_top + 20)
        while y < search_bottom - 20:
            button = self._find_local_button(
                screen,
                seed_x,
                y,
                x_radius=60,
                y_radius=24,
                near_click_x_tolerance=26,
                near_click_y_tolerance=16,
                row_y_tolerance=24,
                min_near_green=120,
            )
            if not button:
                y += step_y
                continue

            if button["center_x"] < search_left - 30 or button["center_x"] > search_right + 30:
                y += step_y
                continue
            if button["center_y"] < search_top + 25 or button["center_y"] > search_bottom - 25:
                y += step_y
                continue
            buttons.append(button)
            y = max(y + step_y, button["top"] + button["height"] + 8)

        buttons.sort(key=lambda item: item["center_y"])
        deduped = []
        for button in buttons:
            if deduped and abs(
                button["center_y"] - deduped[-1]["center_y"]
            ) < 36:
                continue
            deduped.append(button)
        return deduped

    def _is_recent_auto_attempt(self, button):
        if not self.last_auto_attempt:
            return False
        if time.time() - self.last_auto_attempt["timestamp"] > 1.2:
            return False
        return (
            abs(button["center_x"] - self.last_auto_attempt["center_x"]) <= 8
            and abs(button["center_y"] - self.last_auto_attempt["center_y"]) <= 8
        )

    def _click_button(self, x, y):
        original_position = self.mouse_controller.position
        try:
            if self.user32:
                self._send_windows_click(x, y)
            else:
                self.mouse_controller.position = (x, y)
                time.sleep(0.03)
                self.mouse_controller.click(mouse.Button.left, 1)
        finally:
            try:
                if self.user32 and not self.auto_open:
                    self.user32.SetCursorPos(
                        int(original_position[0]),
                        int(original_position[1]),
                    )
                elif not self.user32:
                    self.mouse_controller.position = original_position
            except Exception:
                pass

    def _send_windows_click(self, x, y):
        self.user32.SetCursorPos(int(x), int(y))
        time.sleep(0.08)
        self.user32.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.04)
        self.user32.mouse_event(0x0004, 0, 0, 0, 0)
        time.sleep(0.08)

    def _shorten_row_label(self, row_text):
        first_line = row_text.splitlines()[0].strip() if row_text else "chest"
        return first_line[:60]

    def _load_action_button_template(self):
        template_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "button.png",
        )
        if not os.path.isfile(template_path):
            return None
        try:
            from PIL import Image

            return Image.open(template_path).convert("RGBA")
        except Exception:
            return None

    def _build_template_samples(self, template):
        if template is None:
            return []

        width, height = template.size
        pixels = template.load()
        samples = []
        for y in range(0, height, 6):
            for x in range(0, width, 6):
                red, green, blue, alpha = pixels[x, y]
                if alpha < 200:
                    continue
                samples.append((x, y, red, green, blue))

        if len(samples) > 80:
            step = max(1, len(samples) // 80)
            samples = samples[::step][:80]
        return samples

    def _click_action_button_if_visible(self):
        if self.action_button_template is None or not self.action_button_samples:
            return None

        deadline = time.time() + self.action_button_search_timeout_seconds
        while time.time() < deadline:
            time.sleep(self.action_button_poll_seconds)
            screen = grab_image()
            match = None
            if self.last_action_button_bbox:
                match = self._find_action_button_on_screen(
                    screen,
                    search_bbox=self._expand_bbox(self.last_action_button_bbox, 60, screen.size),
                )
            if not match:
                match = self._find_action_button_on_screen(screen)
            if not match:
                continue

            crop = self._crop_region(screen, match["bbox"])
            self._click_button(match["center_x"], match["center_y"])
            self.last_action_button_bbox = match["bbox"]
            return {
                "center_x": match["center_x"],
                "center_y": match["center_y"],
                "bbox": match["bbox"],
                "before_crop": crop,
            }
        return None

    def _confirm_action_button_clicked(self, action_match):
        time.sleep(self.auto_open_verify_seconds)
        screen = grab_image()
        after_crop = self._crop_region(screen, action_match["bbox"])
        before_crop = action_match["before_crop"]
        if before_crop is not None and after_crop is not None:
            return self._button_crop_changed(before_crop, after_crop)
        return False

    def _find_action_button_on_screen(self, screen, search_bbox=None):
        template = self.action_button_template
        if template is None:
            return None

        screen_rgba = screen.convert("RGBA")
        screen_pixels = screen_rgba.load()
        template_width, template_height = template.size
        width, height = screen_rgba.size

        if search_bbox:
            raw_left, raw_top, raw_right, raw_bottom = search_bbox
            search_left = max(0, min(width - template_width, raw_left))
            search_top = max(0, min(height - template_height, raw_top))
            search_right = max(search_left, min(width - template_width, raw_right - template_width))
            search_bottom = max(search_top, min(height - template_height, raw_bottom - template_height))
        else:
            search_left = max(0, int(width * 0.28))
            search_right = min(width - template_width, int(width * 0.72))
            search_top = max(0, int(height * 0.32))
            search_bottom = min(height - template_height, int(height * 0.88))
        coarse_step = max(4, self.action_button_search_step)

        best = None
        best_score = None
        for y in range(search_top, search_bottom + 1, coarse_step):
            for x in range(search_left, search_right + 1, coarse_step):
                mismatches = 0
                total_delta = 0
                for sample_x, sample_y, red, green, blue in self.action_button_samples:
                    current_red, current_green, current_blue, _ = screen_pixels[
                        x + sample_x, y + sample_y
                    ]
                    delta = (
                        abs(current_red - red)
                        + abs(current_green - green)
                        + abs(current_blue - blue)
                    )
                    if delta > 80:
                        mismatches += 1
                        if mismatches > 8:
                            break
                    total_delta += delta
                else:
                    if best_score is None or total_delta < best_score:
                        best_score = total_delta
                        best = {
                            "center_x": x + template_width // 2,
                            "center_y": y + template_height // 2,
                            "bbox": (x, y, x + template_width, y + template_height),
                        }

        if best is None:
            return None

        fine_left = max(search_left, best["bbox"][0] - coarse_step)
        fine_top = max(search_top, best["bbox"][1] - coarse_step)
        fine_right = min(search_right, best["bbox"][0] + coarse_step)
        fine_bottom = min(search_bottom, best["bbox"][1] + coarse_step)
        for y in range(fine_top, fine_bottom + 1, 2):
            for x in range(fine_left, fine_right + 1, 2):
                mismatches = 0
                total_delta = 0
                for sample_x, sample_y, red, green, blue in self.action_button_samples:
                    current_red, current_green, current_blue, _ = screen_pixels[
                        x + sample_x, y + sample_y
                    ]
                    delta = (
                        abs(current_red - red)
                        + abs(current_green - green)
                        + abs(current_blue - blue)
                    )
                    if delta > 80:
                        mismatches += 1
                        if mismatches > 8:
                            break
                    total_delta += delta
                else:
                    if best_score is None or total_delta < best_score:
                        best_score = total_delta
                        best = {
                            "center_x": x + template_width // 2,
                            "center_y": y + template_height // 2,
                            "bbox": (x, y, x + template_width, y + template_height),
                        }

        return best

    def _expand_bbox(self, bbox, padding, image_size):
        left, top, right, bottom = bbox
        width, height = image_size
        return (
            max(0, left - padding),
            max(0, top - padding),
            min(width, right + padding),
            min(height, bottom + padding),
        )

    def _crop_region(self, screen, bbox):
        left, top, right, bottom = bbox
        left = max(0, left)
        top = max(0, top)
        right = min(screen.size[0], right)
        bottom = min(screen.size[1], bottom)
        if right <= left or bottom <= top:
            return None
        return screen.crop((left, top, right, bottom)).convert("RGB")

    def _on_click(self, x, y, button, pressed):
        if not self.running or not pressed or button != mouse.Button.left:
            return
        # Ignore window chrome and top-bar clicks that are unrelated to chest rows.
        if y < 120:
            return
        clicked_at = time.time()
        with self.frame_lock:
            frame_snapshot = list(self.frame_history)
        try:
            self.click_queue.put_nowait((clicked_at, x, y, frame_snapshot))
        except Full:
            logger.debug("Dropped click because the processing queue is full.")
            return

    def _click_worker_loop(self):
        while self.running or not self.click_queue.empty():
            try:
                clicked_at, x, y, frame_snapshot = self.click_queue.get(timeout=0.2)
            except Empty:
                continue

            try:
                self._process_click(clicked_at, x, y, frame_snapshot)
            except TesseractError as exc:
                if self.running:
                    logger.debug(
                        "Tesseract failed while processing click at (%s, %s): %s",
                        x,
                        y,
                        exc,
                    )
            except Exception as exc:
                logger.error(
                    f"Error while processing click at ({x}, {y}): {exc}",
                    exc_info=True,
                )
                self._notify("ERROR", "Player: ERROR\nChest: Processing failed", 5)
            finally:
                self.click_queue.task_done()

    def _process_click(self, clicked_at, x, y, frame_snapshot):
        row = self._extract_row_from_cached_frames(clicked_at, x, y, frame_snapshot)
        if not row:
            row = self._match_row_by_detected_buttons(clicked_at, x, y, frame_snapshot)

        if not row:
            logger.debug(f"Ignored click at ({x}, {y}) - no valid Open button row detected.")
            return

        if self._is_recent_duplicate(row):
            logger.debug("Ignored duplicate click on the same row.")
            return

        row_image = row["image"]
        row_text = row["text"]
        if not row_text.strip():
            logger.warning("OCR returned no row text for the clicked chest.")
            return

        if self.post_click_verify_seconds > 0:
            if not self._confirm_row_changed_after_click(row):
                logger.debug(
                    "Ignored click because the clicked row still looks unchanged after verification."
                )
                return

        logger.debug(f"Row OCR text: {row_text!r}")
        if not self._save_row_text(row_text, row_image):
            return

        with self.state_lock:
            self.last_saved = {
                "signature": row["signature"],
                "center_x": row["button"]["center_x"],
                "center_y": row["button"]["center_y"],
                "timestamp": time.time(),
            }

    def _confirm_row_changed_after_click(self, row):
        button = row["button"]
        original_signature = row["signature"]
        time.sleep(self.post_click_verify_seconds)

        screen = grab_image()
        current_button = self._find_local_button(
            screen,
            button["center_x"],
            button["center_y"],
        )
        if not current_button:
            return True

        extracted = self._extract_row_from_button(screen, current_button)
        if not extracted:
            return True

        _, current_text = extracted
        current_signature = " ".join(current_text.split()).lower()
        return current_signature != original_signature

    def _frame_loop(self):
        while self.running:
            try:
                self._capture_frame()
            except Exception as exc:
                logger.debug(f"Failed to refresh cached frame: {exc}")
            time.sleep(self.frame_interval_seconds)

    def _capture_frame(self):
        screen = grab_image()
        with self.frame_lock:
            self.frame_history.append((time.time(), screen))

    def _get_candidate_screens(self, clicked_at=None, history=None):
        if history is None:
            with self.frame_lock:
                history = list(self.frame_history)
        else:
            history = list(history)

        if clicked_at is not None:
            prior = [frame for frame in history if frame[0] <= clicked_at + 0.03]
            if prior:
                history = prior

        history.sort(key=lambda item: item[0], reverse=True)
        if not history:
            fresh_screen = grab_image()
            return [(time.time(), fresh_screen)]

        newest_timestamp = history[0][0]
        if time.time() - newest_timestamp > self.frame_interval_seconds * 2.5:
            fresh_screen = grab_image()
            history.insert(0, (time.time(), fresh_screen))

        return history[:3]

    def _extract_row_from_cached_frames(self, clicked_at, x, y, frame_snapshot=None):
        for captured_at, screen in self._get_candidate_screens(clicked_at, frame_snapshot):
            button = self._find_local_button(screen, x, y)
            if not button:
                button = self._find_local_button(
                    screen,
                    x,
                    y,
                    x_radius=240,
                    y_radius=95,
                    near_click_x_tolerance=36,
                    near_click_y_tolerance=24,
                    row_y_tolerance=55,
                    min_near_green=20,
                )
            if not button:
                continue

            extracted = self._extract_row_from_button(screen, button)
            if not extracted:
                continue

            row_image, row_text = extracted
            logger.debug(
                "Matched click at (%s, %s) using local button crop from frame captured %.3fs earlier.",
                x,
                y,
                max(0.0, clicked_at - captured_at),
            )
            return {
                "image": row_image,
                "text": row_text,
                "signature": " ".join(row_text.split()).lower(),
                "button": {
                    "center_x": button["center_x"],
                    "center_y": button["center_y"],
                },
            }
        return None

    def _match_row_by_detected_buttons(self, clicked_at, x, y, frame_snapshot=None):
        found_any_rows = False
        for captured_at, screen in self._get_candidate_screens(clicked_at, frame_snapshot):
            rows = self._find_rows(screen)
            if not rows:
                continue
            found_any_rows = True

            row = self._find_clicked_row(rows, x, y)
            if row:
                logger.debug(
                    "Matched click at (%s, %s) using detected rows from frame captured %.3fs earlier.",
                    x,
                    y,
                    max(0.0, clicked_at - captured_at),
                )
                return row

        if not found_any_rows:
            logger.debug("No visible gift rows with open buttons detected.")
        else:
            logger.debug(f"Ignored click at ({x}, {y}) - not on an Open button.")
        return None

    def _extract_row_near_click(self, screen, x, y):
        width, height = screen.size
        attempts = [
            (0, min(width, x + max(30, int(width * 0.03))), max(0, y - 95), min(height, y + 95)),
            (0, min(width, x + max(48, int(width * 0.05))), max(0, y - 120), min(height, y + 120)),
            (
                max(0, x - max(360, int(width * 0.34))),
                min(width, x + max(40, int(width * 0.04))),
                max(0, y - 115),
                min(height, y + 115),
            ),
            (
                max(0, x - max(220, int(width * 0.20))),
                min(width, x + max(16, int(width * 0.015))),
                max(0, y - 70),
                min(height, y + 70),
            ),
        ]

        best = None
        for left, right, top, bottom in attempts:
            crop = screen.crop((left, top, right, bottom))

            for scale in (1, 2):
                sample = crop if scale == 1 else crop.resize((crop.width * 2, crop.height * 2))
                raw_text = self.ocr.image_analysing(sample)
                normalized = self._normalize_clicked_row_text(raw_text)
                if not normalized:
                    continue

                score = len(normalized)
                if not best or score > best[0]:
                    best = (score, crop, normalized)

        if best:
            return best[1], best[2]
        return None

    def _find_local_button(
        self,
        screen,
        x,
        y,
        x_radius=180,
        y_radius=70,
        near_click_x_tolerance=28,
        near_click_y_tolerance=18,
        row_y_tolerance=45,
        min_near_green=40,
    ):
        width, height = screen.size
        left = max(0, x - x_radius)
        right = min(width, x + x_radius)
        top = max(0, y - y_radius)
        bottom = min(height, y + y_radius)

        rgb = screen.convert("RGB")
        xs = []
        ys = []
        near_click_green = 0
        for py in range(top, bottom):
            for px in range(left, right):
                red, green, blue = rgb.getpixel((px, py))
                if not self._is_button_green(red, green, blue):
                    continue
                if abs(py - y) > row_y_tolerance:
                    continue
                xs.append(px)
                ys.append(py)
                if (
                    abs(px - x) <= near_click_x_tolerance
                    and abs(py - y) <= near_click_y_tolerance
                ):
                    near_click_green += 1

        if near_click_green < min_near_green or not xs:
            return None

        button = {
            "left": min(xs),
            "top": min(ys),
            "width": max(xs) - min(xs) + 1,
            "height": max(ys) - min(ys) + 1,
        }
        button["center_x"] = button["left"] + button["width"] // 2
        button["center_y"] = button["top"] + button["height"] // 2

        if button["width"] < 70 or button["height"] < 20:
            return None

        if not (
            button["left"] - self.click_tolerance
            <= x
            <= button["left"] + button["width"] + self.click_tolerance
            and button["top"] - self.click_tolerance
            <= y
            <= button["top"] + button["height"] + self.click_tolerance
        ):
            return None

        return button

    def _extract_row_from_button(self, screen, button):
        crop = self._crop_row_from_button(screen, button)
        if not crop:
            return None

        normalized = self._ocr_row_crop(crop)
        if normalized:
            normalized = self._replace_chest_line_from_crop(crop, normalized)
            return crop, normalized

        return None

    def _extract_row_text_at_button_position(self, screen, button):
        crop = self._crop_row_from_button(screen, button)
        if not crop:
            return ""
        return self._ocr_row_crop(crop) or ""

    def _crop_button_area(self, screen, button):
        left = max(0, button["left"] - 8)
        top = max(0, button["top"] - 8)
        right = min(screen.size[0], button["left"] + button["width"] + 8)
        bottom = min(screen.size[1], button["top"] + button["height"] + 8)
        if right <= left or bottom <= top:
            return None
        return screen.crop((left, top, right, bottom)).convert("RGB")

    def _button_crop_changed(self, before_crop, after_crop):
        if before_crop.size != after_crop.size:
            return True
        difference = ImageChops.difference(before_crop, after_crop)
        mean_channels = ImageStat.Stat(difference).mean
        mean_difference = sum(mean_channels) / max(1, len(mean_channels))
        return mean_difference >= 10.0

    def _crop_row_from_button(self, screen, button):
        width, height = screen.size
        text_band_width = min(button["left"], max(400, int(width * 0.34)))
        left = max(0, button["left"] - text_band_width)
        right = max(left + 1, button["left"] - 10)
        above_height = max(30, button["height"] // 2 + 8)
        below_height = max(50, button["height"] // 2 + 28)
        top = max(0, button["center_y"] - above_height)
        bottom = min(height, button["center_y"] + below_height)
        if right <= left or bottom <= top:
            return None
        return screen.crop((left, top, right, bottom))

    def _ocr_row_crop(self, crop):
        primary_sample = crop.convert("L").resize((crop.width * 2, crop.height * 2))
        primary_sample = primary_sample.point(lambda value: 255 if value > 155 else 0)
        raw_text = self.ocr.image_analysing(primary_sample, config="--oem 1 --psm 4")
        normalized = self._normalize_clicked_row_text(raw_text)
        if normalized:
            return normalized

        raw_text = self.ocr.image_analysing(crop, config="--oem 1 --psm 4")
        normalized = self._normalize_clicked_row_text(raw_text)
        if normalized:
            return normalized

        return None

    def _replace_chest_line_from_crop(self, crop, normalized_text):
        lines = [line for line in normalized_text.splitlines() if line.strip()]
        if len(lines) < 3:
            return normalized_text

        corrected_name = self._ocr_chest_name_from_row_crop(crop)
        if not corrected_name:
            return normalized_text

        lines[0] = corrected_name
        return "\n".join(lines)

    def _ocr_chest_name_from_row_crop(self, crop):
        chest_crop = crop.crop((0, 0, crop.width, max(1, int(crop.height * 0.38))))
        attempts = [
            chest_crop.resize((chest_crop.width * 2, chest_crop.height * 2)),
            chest_crop,
        ]

        for sample in attempts:
            prepared = sample.convert("L").point(lambda value: 255 if value > 155 else 0)
            raw_text = self.ocr.image_analysing(prepared, config="--oem 1 --psm 7")
            candidate = ""
            for line in raw_text.splitlines():
                stripped = re.sub(r"\s+", " ", line.strip()).strip(" -|:.")
                if stripped:
                    candidate = stripped
                    break
            if not candidate:
                continue

            matched = TextProcessor.normalize_chest_name(candidate)
            if matched and "chest" in matched.lower():
                return matched
        return None

    def _button_looks_like_open(self, screen, button):
        left = max(0, button["left"] - 4)
        top = max(0, button["top"] - 4)
        right = min(screen.size[0], button["left"] + button["width"] + 4)
        bottom = min(screen.size[1], button["top"] + button["height"] + 4)
        crop = screen.crop((left, top, right, bottom))

        attempts = [
            crop,
            crop.resize((crop.width * 2, crop.height * 2)),
            crop.convert("L").resize((crop.width * 3, crop.height * 3)),
        ]

        for sample in attempts:
            text = self.ocr.image_analysing(sample, config="--psm 6")
            normalized = re.sub(r"[^a-z]", "", text.lower())
            if "open" in normalized or "timeleft" in normalized:
                return True
        return False

    def _normalize_clicked_row_text(self, raw_text):
        lines = [
            re.sub(r"\s+", " ", line.strip())
            for line in raw_text.replace(";", ":").splitlines()
            if line.strip()
        ]
        if not lines:
            return ""

        from_index = self._find_label_line(lines, "from")
        source_index = self._find_label_line(lines, "source")
        if from_index is None or source_index is None:
            heuristic = self._normalize_clicked_row_text_without_labels(lines)
            if heuristic:
                return heuristic
            return ""

        if source_index < from_index:
            from_index, source_index = source_index, from_index

        chest_line = self._select_chest_line(lines[:from_index])

        if not chest_line:
            return ""

        from_line = self._standardize_label_line(lines[from_index], "From")
        source_line = self._standardize_label_line(lines[source_index], "Source")
        if not from_line or not source_line:
            return ""

        return "\n".join([chest_line, from_line, source_line])

    def _normalize_clicked_row_text_without_labels(self, lines):
        cleaned_lines = []
        for line in lines:
            cleaned = re.sub(r"\btime\s+left\b.*$", "", line, flags=re.IGNORECASE).strip()
            cleaned = cleaned.strip(" -|:.")
            if cleaned:
                cleaned_lines.append(cleaned)

        if len(cleaned_lines) < 3:
            return ""

        chest_line = self._select_chest_line(cleaned_lines[:1] or cleaned_lines)
        if not chest_line:
            chest_line = cleaned_lines[0]

        player_line = cleaned_lines[1].strip(" -|:.")
        source_line = cleaned_lines[2].strip(" -|:.")

        if not player_line or not source_line:
            return ""
        if not self._looks_like_source_value(source_line):
            return ""

        source_line = self._canonicalize_source_value(source_line)
        return "\n".join(
            [
                chest_line,
                f"From: {player_line}",
                f"Source: {source_line}",
            ]
        )

    def _looks_like_source_value(self, value):
        normalized = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
        if not normalized:
            return False
        for alias, _canonical in self.source_aliases:
            if normalized == alias or normalized.startswith(f"{alias} ") or f" {alias} " in f" {normalized} ":
                return True
        return any(
            keyword in normalized
            for keyword in ("crypt", "citadel", "vault", "arena", "heroic", "ragnarok", "event")
        )

    def _find_label_line(self, lines, label):
        pattern = re.compile(rf"^{label}\b", re.IGNORECASE)
        for index, line in enumerate(lines):
            if pattern.match(line):
                return index
        return None

    def _standardize_label_line(self, line, label):
        match = re.match(rf"^{label}\s*[:.]?\s*(.+)$", line, re.IGNORECASE)
        if not match:
            return ""
        value = match.group(1).strip()
        value = re.sub(r"\btime\s+left\b.*$", "", value, flags=re.IGNORECASE).strip()
        value = re.sub(
            r"\b(help|members?|reinforcements|coordinates|management)\b.*$",
            "",
            value,
            flags=re.IGNORECASE,
        ).strip()
        value = value.strip(" -|:.")

        if label.lower() == "source":
            value = self._canonicalize_source_value(value)

        if not value:
            return ""
        return f"{label}: {value}"

    def _canonicalize_source_value(self, value):
        normalized = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
        for alias, canonical in self.source_aliases:
            if normalized == alias or normalized.startswith(f"{alias} ") or f" {alias} " in f" {normalized} ":
                return canonical
        return value

    def _select_chest_line(self, lines_before_from):
        cleaned_candidates = []
        for line in lines_before_from:
            cleaned = re.sub(r"\btime\s+left\b.*$", "", line, flags=re.IGNORECASE).strip()
            cleaned = cleaned.strip(" -|:.")
            if not cleaned:
                continue
            if re.match(
                r"^(information|members?|reinforcements|coordinates|management|help)\b",
                cleaned,
                re.IGNORECASE,
            ):
                continue
            cleaned_candidates.append(cleaned)

        if not cleaned_candidates:
            return ""

        for candidate in reversed(cleaned_candidates):
            if "chest" in candidate.lower():
                return candidate

        return cleaned_candidates[-1]

    # -------------------------------------------------------------------------
    # ROW DETECTION
    # -------------------------------------------------------------------------
    def _find_rows(self, image):
        width, height = image.size
        data = self.ocr.extract_data(image, config="--psm 11")
        tokens = []
        for index, raw_text in enumerate(data["text"]):
            text = raw_text.strip()
            if not text:
                continue

            confidence = (
                float(data["conf"][index]) if data["conf"][index] != "-1" else -1.0
            )
            if confidence < 45:
                continue

            tokens.append(
                {
                    "text": text,
                    "normalized": text.lower().rstrip(":"),
                    "left": data["left"][index],
                    "top": data["top"][index],
                    "width": data["width"][index],
                    "height": data["height"][index],
                }
            )

        from_tokens = [token for token in tokens if token["normalized"] == "from"]
        source_tokens = [token for token in tokens if token["normalized"] == "source"]
        rows = []

        for from_token in from_tokens:
            source_token = self._match_source_token(from_token, source_tokens)
            if not source_token:
                continue

            row = self._build_row_from_tokens(image, from_token, source_token)
            if row:
                rows.append(row)

        rows.sort(key=lambda item: item["button"]["center_y"])
        deduped = []
        for row in rows:
            if deduped and abs(
                row["button"]["center_y"] - deduped[-1]["button"]["center_y"]
            ) < max(12, row["scale"] * 3):
                continue
            deduped.append(row)

        if deduped:
            logger.debug(f"Detected {len(deduped)} visible gift rows.")
        return deduped

    def _match_source_token(self, from_token, source_tokens):
        best = None
        best_delta = None
        x_tolerance = max(30, from_token["height"] * 6)
        max_delta_y = max(30, from_token["height"] * 6)
        for source_token in source_tokens:
            delta_y = source_token["top"] - from_token["top"]
            if delta_y <= 0 or delta_y > max_delta_y:
                continue
            if abs(source_token["left"] - from_token["left"]) > x_tolerance:
                continue
            if best is None or delta_y < best_delta:
                best = source_token
                best_delta = delta_y
        return best

    def _build_row_from_tokens(self, image, from_token, source_token):
        width, height = image.size
        scale = max(from_token["height"], source_token["height"])

        top = max(0, from_token["top"] - scale * 4)
        bottom = min(height, source_token["top"] + source_token["height"] + scale * 3)
        text_left = max(0, from_token["left"] - scale * 2)
        button_search_left = min(width - 1, from_token["left"] + scale * 42)
        button_search_right = min(width, from_token["left"] + scale * 78)
        if button_search_right <= button_search_left:
            return None

        button = self._find_button_in_band(
            image, button_search_left, button_search_right, top, bottom, scale
        )
        if not button:
            return None

        text_right = max(text_left + 80, button["left"] - scale * 4)
        row_image = image.crop((text_left, top, text_right, bottom))
        row_text = self.ocr.image_analysing(row_image)
        row_signature = " ".join(row_text.split()).lower()
        return {
            "button": button,
            "image": row_image,
            "text": row_text,
            "signature": row_signature,
            "scale": scale,
        }

    def _find_button_in_band(
        self, image, search_left, search_right, top, bottom, scale
    ):
        rgb = image.convert("RGB")
        xs = []
        ys = []
        for y in range(top, bottom):
            for x in range(search_left, search_right):
                red, green, blue = rgb.getpixel((x, y))
                if self._is_button_green(red, green, blue):
                    xs.append(x)
                    ys.append(y)

        if not xs:
            return None

        left = min(xs)
        right = max(xs)
        button_top = min(ys)
        button_bottom = max(ys)
        button_width = right - left + 1
        button_height = button_bottom - button_top + 1
        if button_width < scale * 8 or button_height < scale * 2:
            return None

        return {
            "left": left,
            "top": button_top,
            "width": button_width,
            "height": button_height,
            "center_x": left + button_width // 2,
            "center_y": button_top + button_height // 2,
        }

    def _is_button_green(self, red, green, blue):
        return green > 60 and green > red * 0.8 and green > blue * 1.15

    def _find_clicked_row(self, rows, x, y):
        candidates = []
        for row in rows:
            button = row["button"]
            left = button["left"] - self.click_tolerance
            top = button["top"] - self.click_tolerance
            right = button["left"] + button["width"] + self.click_tolerance
            bottom = button["top"] + button["height"] + self.click_tolerance
            if left <= x <= right and top <= y <= bottom:
                candidates.append(row)

        if not candidates:
            return None

        candidates.sort(key=lambda row: abs(row["button"]["center_y"] - y))
        return candidates[0]

    def _is_recent_duplicate(self, row):
        with self.state_lock:
            if not self.last_saved:
                return False
            if time.time() - self.last_saved["timestamp"] > self.duplicate_window_seconds:
                return False
            if row["signature"] != self.last_saved["signature"]:
                return False
            return (
                abs(row["button"]["center_x"] - self.last_saved["center_x"]) <= 6
                and abs(row["button"]["center_y"] - self.last_saved["center_y"]) <= 6
            )

    # -------------------------------------------------------------------------
    # PERSISTENCE
    # -------------------------------------------------------------------------
    def _save_row_text(self, row_text, row_image):
        tp = TextProcessor(row_text)
        player = tp.get_player_name()
        if not player:
            logger.warning("No player name detected from the clicked gift row OCR.")
            self._notify("ERROR", "Player: None\nChest: Failed to detect player", 5)
            if self.screenshot_error_show:
                row_image.show()
            return False

        chest_record = Chest(
            clan="",
            chest_name=tp.get_chest_name(),
            chest_source=tp.get_chest_source(),
            chest_name_sureness=0,  # Not needed in the stable version.
            player_name=tp.get_player_name(),
            player_name_sureness=0,  # Not needed in the stable version.
            level=0,
            points=tp.get_points(),
            raw_body=row_text,
        )

        with DB_gs() as session:
            session.add(chest_record)
            session.commit()
            session.refresh(chest_record)

        logger.debug(f"[json] {json.dumps(chest_record.to_dict(), default=str)}")
        logger.info(
            "Saved %s: %s (%s).",
            player,
            chest_record.chest_name,
            chest_record.chest_source,
        )
        self._notify("Success", f"Player: {player}\nChest: {tp.get_chest_name()}", 1)
        return True

    def _notify(self, title, message, timeout):
        if not self.show_notifications:
            return
        try:
            from plyer import notification

            notification.notify(title=title, message=message, timeout=timeout)
        except Exception as exc:
            logger.debug(f"Desktop notification skipped: {exc}")

    # -------------------------------------------------------------------------
    # SHUTDOWN
    # -------------------------------------------------------------------------
    def stop(self):
        self.running = False
        if self.listener:
            self.listener.stop()
            try:
                self.listener.join(1)
            except RuntimeError:
                pass
        self.click_queue.join()
        if self.frame_thread and self.frame_thread.is_alive():
            self.frame_thread.join(1)
        for worker_thread in self.worker_threads:
            if worker_thread and worker_thread.is_alive():
                worker_thread.join(5)
        logger.info("Counter stopped.")
