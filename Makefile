# Ścieżka do wirtualnego środowiska
VENV_PATH = venv

# Ścieżka do pliku requirements.txt
REQUIREMENTS = requirements.txt

# Instalacja zależności z pliku requirements.txt
install: $(VENV_PATH)/bin/activate
	$(VENV_PATH)/bin/pip install -r $(REQUIREMENTS)

# Zamrażanie zainstalowanych pakietów do requirements.txt
freeze: $(VENV_PATH)/bin/activate
	$(VENV_PATH)/bin/pip freeze > $(REQUIREMENTS)

# Uwaga: Aby aktywować środowisko, użyj komendy:
# source venv/bin/activate

