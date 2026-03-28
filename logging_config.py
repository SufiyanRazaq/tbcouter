import logging
import os


def setup_logger(name):
    """Configure a logger for the given module name."""
    log_dir = "logs"
    os.makedirs(log_dir, exist_ok=True)  # Ensure the log directory exists.

    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] [%(name)s {%(lineno)d}] %(message)s"
    )

    file_handler = logging.FileHandler(os.path.join(log_dir, "project.log"))
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(formatter)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger
