import csv

import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build


class GoogleSheetsHandler:
    def __init__(self, credentials_path, spreadsheet_name, scopes=None):
        """
        Initialize the Google Sheets client.

        :param credentials_path: Path to the JSON credentials file.
        :param spreadsheet_name: Spreadsheet name.
        :param scopes: List of access scopes.
        """
        if scopes is None:
            scopes = [
                "https://www.googleapis.com/auth/spreadsheets",
                "https://www.googleapis.com/auth/drive.file",
            ]
        self.credentials = Credentials.from_service_account_file(
            credentials_path, scopes=scopes
        )
        self.gc = gspread.authorize(self.credentials)
        self.sheets_api = build("sheets", "v4", credentials=self.credentials)
        self.spreadsheet_name = spreadsheet_name
        self.spreadsheet = self._get_or_create_spreadsheet()

    def _get_or_create_spreadsheet(self):
        """Open an existing spreadsheet that is already shared with the service account."""
        try:
            spreadsheet = self.gc.open(self.spreadsheet_name)
            print(f"Spreadsheet already exists: {spreadsheet.url}")
            return spreadsheet
        except gspread.exceptions.SpreadsheetNotFound as exc:
            raise RuntimeError(
                f"Spreadsheet '{self.spreadsheet_name}' was not found. "
                "Create it manually in Google Sheets and share it with the service account email."
            ) from exc
        return spreadsheet

    def load_csv_to_sheet(self, csv_file, worksheet_index=0):
        """
        Load data from a CSV file and update the worksheet.

        :param csv_file: Path to the CSV file.
        :param worksheet_index: Worksheet index to update.
        """
        with open(csv_file, mode="r", encoding="utf-8", newline="") as file:
            csv_reader = csv.reader(file)
            data = [self._coerce_numeric_cells(row) for row in csv_reader]

        worksheet = self.spreadsheet.get_worksheet(worksheet_index)
        if not worksheet:
            print("Worksheet not found, creating a new one...")
            worksheet = self.spreadsheet.add_worksheet(
                title="Sheet1", rows="100", cols="20"
            )

        worksheet.clear()
        worksheet.update("A1", data)
        print("CSV data has been loaded into the worksheet.")

    def auto_resize_columns(self, worksheet_index=0):
        """
        Auto-resize columns based on worksheet data.

        :param worksheet_index: Worksheet index.
        """
        worksheet = self.spreadsheet.get_worksheet(worksheet_index)
        if not worksheet:
            print("Worksheet not found. Operation aborted.")
            return

        points_column_index = self._find_points_column_index(worksheet.get_all_values())

        requests = [
            {
                "autoResizeDimensions": {
                    "dimensions": {
                        "sheetId": worksheet.id,
                        "dimension": "COLUMNS",
                        "startIndex": 0,
                        "endIndex": worksheet.col_count,
                    }
                }
            },
        ]

        if points_column_index is not None:
            requests.insert(
                0,
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": worksheet.id,
                            "startColumnIndex": points_column_index - 1,
                            "endColumnIndex": points_column_index,
                        },
                        "cell": {
                            "userEnteredFormat": {"numberFormat": {"type": "NUMBER"}}
                        },
                        "fields": "userEnteredFormat.numberFormat",
                    }
                },
            )

        self.sheets_api.spreadsheets().batchUpdate(
            spreadsheetId=self.spreadsheet.id, body={"requests": requests}
        ).execute()
        print("Column widths have been adjusted.")

    def _find_points_column_index(self, rows):
        for row in rows:
            for index, value in enumerate(row, start=1):
                if value.strip().lower() == "points":
                    return index
        return None

    def _column_index_to_letter(self, index):
        letters = []
        while index > 0:
            index, remainder = divmod(index - 1, 26)
            letters.append(chr(65 + remainder))
        return "".join(reversed(letters))

    def _coerce_numeric_cells(self, row):
        coerced = []
        for value in row:
            stripped = value.strip()
            if stripped.isdigit():
                coerced.append(int(stripped))
                continue
            try:
                if stripped and stripped.count(".") == 1:
                    coerced.append(float(stripped))
                    continue
            except ValueError:
                pass
            coerced.append(value)
        return coerced
