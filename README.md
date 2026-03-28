# Total Battle Chest Counter

Unofficial Windows chest counter for Total Battle.

This tool reads chest rows while you open chests manually, saves the detected player/chest/source data locally, and exports a weekly CSV summary.

## Included Runtime Layout

This project is prepared to work from the project folder itself.

Recommended package structure:

```text
tbcouter/
├─ .venv/
├─ runtime/
│  ├─ python/
│  └─ Tesseract-OCR/
├─ storage/
├─ scripts/
├─ models/
├─ data/
├─ main.py
├─ run_counter.bat
├─ export_csv.bat
└─ README.md
```

## What Buyers Need

- Windows 10 or Windows 11
- The game visible on screen
- This project folder, including:
  - `.venv`
  - `runtime/python`
  - `runtime/Tesseract-OCR`

## Quick Start

1. Extract the full project folder.
2. Open the project folder.
3. Double-click `run_counter.bat`
4. If asked whether to clear saved chest data, choose:
   - `y` for a fresh test/new week
   - `n` to keep existing saved data
5. Open chests manually in-game.
6. Press `Ctrl+C` to stop.
7. Choose `y` if you want to generate the local CSV summary.

The exported CSV is:

```text
storage\thisweek.csv
```

## Main Behavior

- Manual mode only
- You open the chests yourself
- The tool reads:
  - player name
  - chest name
  - source
  - points
- Data is stored locally in:

```text
storage\chest_counter.db
```

## Launch Files

### `run_counter.bat`

Starts the chest counter from the project folder.

### `export_csv.bat`

Exports the current saved data to:

```text
storage\thisweek.csv
```

## Bundled Python

This package is set up to use a bundled Python runtime from:

```text
runtime\python
```

The batch launcher can repair `.venv\Scripts\python.exe` from the bundled runtime if needed.

## Bundled Tesseract

This package is set up to prefer a bundled Tesseract from:

```text
runtime\Tesseract-OCR\tesseract.exe
```

If that file exists, the project will use it automatically.

## If Data “Comes Back” After Deleting CSV Rows

The CSV is only an export file.

The real saved data is stored in:

```text
storage\chest_counter.db
```

So if you delete rows only from `storage\thisweek.csv`, those rows will return the next time you export.

To fully reset saved data:

1. Run the counter
2. Answer `y` to:

```text
Clear all saved chest data before starting?
```

## If The App Says “Access Is Denied”

That usually means:

```text
.venv\Scripts\python.exe
```

became broken or empty.

Use:

```text
run_counter.bat
```

The launcher will try to repair the local venv launcher from the bundled Python runtime.

## Notes

- This is an unofficial tool.
- It is not affiliated with or endorsed by Total Battle.
- OCR accuracy depends on the visible game UI, scaling, and screenshot quality.
- Some names may still need occasional manual cleanup if the game text is blurred or partially hidden.
