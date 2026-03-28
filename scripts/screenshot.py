import mss
from PIL import Image


class Screenshot:

    def __init__(self, region, queue):
        self.region = region
        self.image_queue = queue
        self.take_shot()

    def take_shot(self):
        with mss.mss() as sct:
            screenshot = sct.grab(self.region)
            image = Image.frombytes("RGB", screenshot.size, screenshot.rgb)
            self.image_queue.put(image)
            # image.show()

    def get_image(self):
        return self.take_shot()


def grab_image(region=None):
    with mss.mss() as sct:
        monitor = region or sct.monitors[1]
        screenshot = sct.grab(monitor)
        return Image.frombytes("RGB", screenshot.size, screenshot.rgb)
