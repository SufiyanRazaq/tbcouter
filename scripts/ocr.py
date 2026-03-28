import os

import pytesseract
from pytesseract import Output


class OCR:

    def __init__(self):
        self.pytesseract = pytesseract
        self._configure_tesseract()

    def _configure_tesseract(self):
        if os.name == "nt":
            project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            candidate_paths = [
                os.path.join(project_root, "runtime", "Tesseract-OCR", "tesseract.exe"),
                os.path.join(project_root, "Tesseract-OCR", "tesseract.exe"),
            ]
            for candidate in candidate_paths:
                if os.path.isfile(candidate):
                    self.pytesseract.pytesseract.tesseract_cmd = candidate
                    return

            custom_cmd = os.getenv("TESSERACT_CMD")
            if custom_cmd:
                self.pytesseract.pytesseract.tesseract_cmd = custom_cmd
                return

            default_windows_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
            if os.path.isfile(default_windows_path):
                self.pytesseract.pytesseract.tesseract_cmd = default_windows_path
                return

        custom_cmd = os.getenv("TESSERACT_CMD")
        if custom_cmd:
            self.pytesseract.pytesseract.tesseract_cmd = custom_cmd

    def extract_text(self, image, config=""):
        # image.show()
        text = self.pytesseract.image_to_string(image, config=config)
        return text

    def extract_data(self, image, config=""):
        return self.pytesseract.image_to_data(
            image, config=config, output_type=Output.DICT
        )

    def image_analysing(self, image, config=""):
        text = self.extract_text(image, config=config)
        return text
