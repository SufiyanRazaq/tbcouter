from scripts.counter import Counter
from models.database import clear_all_chests


def ask_yes_no(prompt: str) -> bool:
    """Simple yes/no prompt."""
    try:
        return input(f"{prompt} (y/n): ").strip().lower() == "y"
    except (EOFError, KeyboardInterrupt):
        return False


def main():
    print("=== CHEST COUNTER ===")

    if ask_yes_no("Clear all saved chest data before starting?"):
        clear_all_chests()
        print("Saved chest data cleared.")

    counter = Counter(
        db_filename="chest_counter.db",
        auto_create_db=True,
        screenshot_error_show=False,
        show_notifications=False,
        auto_open=False,
        frame_interval_seconds=0.05,
        click_queue_size=200,
        worker_count=2,
    )

    try:
        print("System is running in manual mode. Click Open buttons yourself. Press CTRL+C to stop.")
        counter.start()
    except KeyboardInterrupt:
        pass
    finally:
        print("Stopping...")
        counter.stop()

        if ask_yes_no("Generate weekly CSV file?"):
            from scripts.create_csv import fetch_and_save_to_csv

            fetch_and_save_to_csv()
            print("Local CSV updated: storage/thisweek.csv")

    print("Program finished.")


if __name__ == "__main__":
    main()
