import re

from fuzzywuzzy import fuzz

from data.chest_points_list import chest_points_list
from data.chests_list import chest_list
from data.players_list import player_list, synonyms
from logging_config import setup_logger

logger = setup_logger(__name__)


class TextProcessor:
    def __init__(self, text):
        self.chests_list = chest_list
        self.players_list = player_list
        self.player_synonyms = synonyms
        self.chest_points_list = chest_points_list
        self.text = self.sanitize_text(text)

        self.player_name = self._extract_player_name(self.text)
        self.chest_name = self._extract_chest_name(self.text)
        self.chest_source = self._extract_chest_source(self.text)
        self.chest_points = self.assign_points(self.chest_name, self.chest_source)

    @staticmethod
    def _normalize_for_match(value):
        normalized = str(value or "").lower()
        replacements = {
            "â€™": "'",
            "â€˜": "'",
            "Ã©": "e",
            "|": " ",
        }
        for old, new in replacements.items():
            normalized = normalized.replace(old, new)
        normalized = re.sub(r"[^a-z0-9']+", " ", normalized)
        return normalized.strip()

    @classmethod
    def compare_string_candidates(cls, input_string, compare_list, threshold=95, debug=False):
        """
        Compares the given string against a list and returns the best matching name.

        If no match is found above the threshold, it returns the original string.

        Args:
            input_string (str): The string to compare.
            compare_list (list): The list to compare against.
            threshold (int): Minimum similarity threshold (default 95).
            debug (bool): Whether to log detailed matching info (default False).

        Returns:
            str: The best match found in the list or the original string if no match exceeds the threshold.
        """
        normalized_input = cls._normalize_for_match(input_string)
        if not normalized_input:
            return input_string

        best_match = input_string
        fuzz_indicator = 0
        for name in compare_list:
            normalized_name = cls._normalize_for_match(name)
            similarity = max(
                fuzz.ratio(normalized_input, normalized_name),
                fuzz.partial_ratio(normalized_input, normalized_name),
                fuzz.token_sort_ratio(normalized_input, normalized_name),
                fuzz.token_set_ratio(normalized_input, normalized_name),
            )
            if similarity > fuzz_indicator:
                best_match = name
                fuzz_indicator = similarity

        if fuzz_indicator >= threshold:
            if debug:
                logger.debug(f"Best match: {best_match} for string: {input_string}")
            return best_match
        return input_string

    def compare_strings(self, input_string, compare_list, threshold=95, debug=False):
        return self.compare_string_candidates(input_string, compare_list, threshold, debug)

    @classmethod
    def normalize_chest_name(cls, input_string, threshold=70, debug=False):
        return cls.compare_string_candidates(input_string, chest_list, threshold, debug)

    def compare_chest_strings(self, input_string, threshold=70, debug=False):
        return self.compare_strings(input_string, self.chests_list, threshold, debug)

    def compare_player_names(self, input_name, threshold=95):
        """
        Compares the provided player name with a list of existing player names
        and returns the best matching name, or checks the synonym list if no match is found.

        Args:
            input_name (str): The name of the player to compare.
            threshold (int): Minimum similarity threshold (default 95).

        Returns:
            str: The best matching player name or the original name if no match is found.
        """
        best_match = self.compare_strings(input_name, self.players_list, threshold)

        if best_match == input_name:
            synonym_name = self.player_synonyms.get(input_name, None)
            if synonym_name:
                logger.debug(
                    f'Using synonym for "{input_name}", returning "{synonym_name}"'
                )
                return synonym_name
        return best_match

    def assign_points(self, chest_name, chest_source):
        """
        Assign points to the chest based on its name or source.

        Args:
            chest_name (str): The name of the chest.
            chest_source (str): The source of the chest (e.g., "Bank").

        Returns:
            int: The number of points assigned to the chest.
        """
        key = chest_name if chest_source == "Bank" else chest_source
        return self.chest_points_list.get(key, 0)

    def _extract_data(self, text, pattern, process_fn=None):
        """
        Extracts data from the text using a regex pattern and an optional processing function.

        Args:
            text (str): The text to search within.
            pattern (str): The regex pattern to match.
            process_fn (function): An optional function to process the matched result.

        Returns:
            str: The processed result if found, or None if no match is found.
        """
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            result = match.group().strip()
            return process_fn(result) if process_fn else result
        return None

    def _extract_player_name(self, text):
        return self._extract_data(text, r"(?<=From:.).*", self.compare_player_names)

    def _extract_chest_name(self, text):
        return self.compare_chest_strings(text.split("\n")[0])

    def _extract_chest_source(self, text):
        return self._extract_data(text, r"(?<=Source:.).*")

    def sanitize_text(self, text):
        """
        Sanitizes the text to handle OCR errors (e.g., replacing semicolons with colons).

        Args:
            text (str): The raw text to sanitize.

        Returns:
            str: The sanitized text.
        """
        return "\n".join(
            line.strip() for line in text.replace(";", ":").splitlines() if line.strip()
        )

    def get_player_name(self):
        return self.player_name

    def get_chest_name(self):
        return self.chest_name

    def get_chest_level(self):
        return self.chest_level

    def get_chest_source(self):
        return self.chest_source.rstrip(".") if self.chest_source else ""

    def get_points(self):
        return self.chest_points

    def __str__(self):
        return f"Player: {self.player_name}\nChest: {self.chest_name}\nLevel: {self.chest_level}\nPoints: {self.chest_points}"
