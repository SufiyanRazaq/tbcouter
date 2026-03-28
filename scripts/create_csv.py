import csv
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from data.chest_points_list import (  # noqa: E402
    chest_category_aliases,
    chest_points_list,
    export_category_order,
)
from models.database import initialize_database  # noqa: E402

TEMPLATE_CSV = os.path.join(PROJECT_ROOT, "TBK-178 CHEST COUNTER - Chest count total.csv")
STATUS_MESSAGE = (
    "The chest counter is running, and will count chests at the beginning of each hour."
)


def _parse_number(value):
    stripped = str(value).replace(",", "").strip()
    if not stripped:
        return 0
    try:
        return int(float(stripped))
    except ValueError:
        return 0


def _normalize_key(value):
    normalized = str(value or "").strip().lower()
    replacements = {
        "’": "'",
        "‘": "'",
        "´": "'",
        "`": "'",
        "Ã©": "e",
        "â€™": "'",
    }
    for old, new in replacements.items():
        normalized = normalized.replace(old, new)
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return normalized.strip()


def _value_after_label(row, label):
    try:
        index = row.index(label)
    except ValueError:
        return ""
    for value in row[index + 1 :]:
        stripped = value.strip()
        if stripped:
            return stripped
    return ""


def _parse_template_start_time(value):
    stripped = value.strip()
    if not stripped:
        return None
    try:
        return datetime.strptime(stripped, "%m/%d/%Y %H:%M:%S").replace(tzinfo=UTC)
    except ValueError:
        return None


def _load_sheet_template():
    if not os.path.exists(TEMPLATE_CSV):
        return None

    with open(TEMPLATE_CSV, encoding="utf-8-sig", newline="") as file:
        rows = list(csv.reader(file))

    if len(rows) < 6:
        return None

    header = rows[2]
    points_row = rows[3] if len(rows) > 3 else []
    seen_labels = Counter()
    category_columns = []
    category_points = {}

    for index, label in enumerate(header[4:], start=4):
        cleaned = label.strip()
        if not cleaned:
            continue
        seen_labels[cleaned] += 1
        category_columns.append(cleaned)
        category_points.setdefault(
            cleaned,
            _parse_number(points_row[index] if index < len(points_row) else 0),
        )

    title_cell = rows[0][0].strip() if rows[0] else ""
    clan_name = _value_after_label(rows[1], "Clan Name:")
    point_min = _parse_number(_value_after_label(rows[1], "point Min:"))
    chest_min = _parse_number(_value_after_label(rows[1], "Chest Min:"))
    cycle_days = _parse_number(_value_after_label(rows[1], "Days in Cycle:"))
    start_time = _parse_template_start_time(_value_after_label(rows[1], "Start Time (GMT):"))

    return {
        "title_cell": title_cell,
        "clan_name": clan_name,
        "point_min": point_min,
        "chest_min": chest_min,
        "cycle_days": cycle_days or 6,
        "start_time": start_time,
        "category_columns": category_columns,
        "category_points": category_points,
    }


def _merge_template_points(template_points):
    merged = dict(template_points)
    for category, local_points in chest_points_list.items():
        if category in merged and merged[category] == 0 and local_points:
            merged[category] = local_points
    return merged


def _calculate_cycle_window(reference_utc, template):
    anchor = template["start_time"] if template else None
    if anchor:
        cycle_start = anchor
        cycle_step = timedelta(days=7)
        while cycle_start > reference_utc:
            cycle_start -= cycle_step
        while cycle_start + cycle_step <= reference_utc:
            cycle_start += cycle_step
    else:
        cycle_start = reference_utc - timedelta(days=reference_utc.weekday())
        cycle_start = cycle_start.replace(hour=0, minute=0, second=0, microsecond=0)

    cycle_end = cycle_start + timedelta(days=7) - timedelta(seconds=1)
    return cycle_start, cycle_end


def _format_cycle_title(clan_name, cycle_start, cycle_end, cycle_days):
    prefix = clan_name or "Chest Counter"
    display_end = cycle_start + timedelta(days=cycle_days)
    return f"{prefix} Chests \n({cycle_start.strftime('%m/%d')}-{display_end.strftime('%m/%d')})"


def _format_timestamp(value):
    if not value:
        return ""
    if isinstance(value, str):
        return value
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _format_lag(now_utc, last_processed):
    if not last_processed:
        return ""
    delta = now_utc.replace(tzinfo=None) - last_processed
    if delta.total_seconds() < 0:
        return "0h 0m"
    total_minutes = int(delta.total_seconds() // 60)
    hours, minutes = divmod(total_minutes, 60)
    return f"{hours}h {minutes}m"


def _resolve_category_name(raw_value):
    cleaned = str(raw_value or "").rstrip(".").strip()
    if not cleaned:
        return ""
    alias = chest_category_aliases.get(_normalize_key(cleaned))
    if alias:
        return alias
    return cleaned


def _resolve_category(chest_name, chest_source):
    for candidate in (chest_source, chest_name):
        resolved = _resolve_category_name(candidate)
        if resolved:
            return resolved
    return "Unknown"


def _resolve_points(category, template_points, observed_points):
    if category in template_points:
        return template_points[category]
    if category in chest_points_list:
        return chest_points_list[category]
    return observed_points or 0


def _build_category_columns(template, template_points, observed_categories):
    ordered = []
    seen = set()

    for category in export_category_order:
        ordered.append(category)
        seen.add(category)

    if template:
        for category in template["category_columns"]:
            if category not in seen:
                ordered.append(category)
                seen.add(category)
    else:
        for category in template_points:
            if category not in seen:
                ordered.append(category)
                seen.add(category)

    for category in observed_categories:
        if category not in seen:
            ordered.append(category)
            seen.add(category)

    return ordered


def _build_player_rows(observed_players):
    ordered_players = []
    for player_name in sorted(observed_players, key=str.lower):
        ordered_players.append({"required_points": 0, "name": player_name})
    return ordered_players


def _query_cycle_rows(cursor, cycle_start, cycle_end):
    query = """
    SELECT player_name, chest_name, chest_source, points
    FROM chest
    WHERE indatetime BETWEEN ? AND ?
    ORDER BY id ASC;
    """
    cursor.execute(
        query,
        (
            cycle_start.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S"),
            cycle_end.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S"),
        ),
    )
    return cursor.fetchall()


def fetch_and_save_to_csv():
    initialize_database()

    template = _load_sheet_template()
    now_utc = datetime.now(UTC)
    cycle_start, cycle_end = _calculate_cycle_window(now_utc, template)

    db_path = os.path.join("storage", "chest_counter.db")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("SELECT MAX(indatetime) FROM chest")
    last_processed_raw = cursor.fetchone()[0]
    last_processed = (
        datetime.fromisoformat(last_processed_raw) if last_processed_raw else None
    )
    results = _query_cycle_rows(cursor, cycle_start, cycle_end)

    if not results and last_processed:
        cycle_start, cycle_end = _calculate_cycle_window(
            last_processed.replace(tzinfo=UTC), template
        )
        results = _query_cycle_rows(cursor, cycle_start, cycle_end)

    player_counts = defaultdict(Counter)
    observed_categories = []
    seen_categories = set()
    template_points = _merge_template_points(template["category_points"]) if template else {}

    for player_name, chest_name, chest_source, observed_points in results:
        category = _resolve_category(chest_name, chest_source)
        player_counts[player_name][category] += 1
        if category not in seen_categories:
            observed_categories.append(category)
            seen_categories.add(category)
        template_points.setdefault(
            category, _resolve_points(category, template_points, observed_points or 0)
        )

    category_columns = _build_category_columns(template, template_points, observed_categories)
    player_rows = _build_player_rows(player_counts.keys())

    player_totals = {}
    player_chest_counts = {}
    clan_totals = Counter()
    total_points = 0
    total_chests = 0

    for player in player_rows:
        name = player["name"]
        counts = player_counts.get(name, Counter())
        player_total = sum(counts[category] * template_points.get(category, 0) for category in counts)
        player_count = sum(counts.values())
        player_totals[name] = player_total
        player_chest_counts[name] = player_count
        clan_totals.update(counts)
        total_points += player_total
        total_chests += player_count

    sheet_width = 4 + len(category_columns)
    title_row = [""] * sheet_width
    title_row[0] = _format_cycle_title(
        template["clan_name"] if template else "",
        cycle_start,
        cycle_end,
        template["cycle_days"] if template else 6,
    )
    if sheet_width > 3:
        title_row[3] = STATUS_MESSAGE
    if sheet_width > 12:
        title_row[12] = "Last Chest Processed:"
    if sheet_width > 13:
        title_row[13] = _format_timestamp(last_processed)
    if sheet_width > 14:
        title_row[14] = "Active Now"
    if sheet_width > 15:
        title_row[15] = "TRUE"
    if sheet_width > 16:
        title_row[16] = "Chest Lag:"
    if sheet_width > 17:
        title_row[17] = _format_lag(now_utc, last_processed)

    meta_row = [""] * sheet_width
    meta_row[0] = "TRUE"
    if sheet_width > 3:
        meta_row[3] = "Clan Name:"
    if sheet_width > 4:
        meta_row[4] = template["clan_name"] if template else ""
    if sheet_width > 5:
        meta_row[5] = "point Min:"
    if sheet_width > 6:
        meta_row[6] = template["point_min"] if template else 0
    if sheet_width > 7:
        meta_row[7] = "Chest Min:"
    if sheet_width > 8:
        meta_row[8] = template["chest_min"] if template else 0
    if sheet_width > 9:
        meta_row[9] = "Days in Cycle:"
    if sheet_width > 10:
        meta_row[10] = template["cycle_days"] if template else 6
    if sheet_width > 15:
        meta_row[15] = "last collect"
    if sheet_width > 16:
        meta_row[16] = _format_timestamp(last_processed)
    if sheet_width > 17:
        meta_row[17] = "Last adjusted"
    if sheet_width > 18:
        meta_row[18] = _format_timestamp(now_utc)
    if sheet_width > 20:
        meta_row[20] = "Start Time (GMT):"
    if sheet_width > 21:
        meta_row[21] = _format_timestamp(cycle_start)

    header_row = ["Adjusted Point Requirement", "Name", "Total points", "Chest\nCount"] + category_columns
    points_row = ["", "Points per chest:", "", ""] + [
        template_points.get(category, 0) for category in category_columns
    ]
    minimum_row = ["", "Required Minimum:", template["point_min"] if template else 0, ""] + [
        "" for _ in category_columns
    ]
    total_row = ["", "Total in Clan", total_points, total_chests] + [
        clan_totals.get(category, 0) for category in category_columns
    ]

    csv_file_path = os.path.join("storage", "thisweek.csv")
    with open(csv_file_path, mode="w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(title_row)
        writer.writerow(meta_row)
        writer.writerow(header_row)
        writer.writerow(points_row)
        writer.writerow(minimum_row)
        writer.writerow(total_row)

        for player in player_rows:
            name = player["name"]
            counts = player_counts.get(name, Counter())
            row = [
                player["required_points"],
                name,
                player_totals[name],
                player_chest_counts[name],
            ]
            row.extend(counts.get(category, 0) for category in category_columns)
            writer.writerow(row)

    print(f"Data has been saved to the file: {csv_file_path}")
    conn.close()


if __name__ == "__main__":
    fetch_and_save_to_csv()
