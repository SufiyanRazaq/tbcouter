@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "VENV_PY=%PROJECT_DIR%.venv\Scripts\python.exe"
set "RUNTIME_PY=%PROJECT_DIR%runtime\python\python.exe"
set "LOCAL_TESS=%PROJECT_DIR%runtime\Tesseract-OCR\tesseract.exe"

if exist "%RUNTIME_PY%" (
    if not exist "%VENV_PY%" (
        copy /Y "%RUNTIME_PY%" "%VENV_PY%" >nul
    )
)

if exist "%VENV_PY%" (
    for %%I in ("%VENV_PY%") do set "VENV_SIZE=%%~zI"
    if "%VENV_SIZE%"=="0" (
        if exist "%RUNTIME_PY%" (
            copy /Y "%RUNTIME_PY%" "%VENV_PY%" >nul
        )
    )
)

if exist "%LOCAL_TESS%" (
    set "TESSERACT_CMD=%LOCAL_TESS%"
)

if not exist "%VENV_PY%" (
    echo Python launcher not found.
    echo Expected:
    echo %VENV_PY%
    pause
    exit /b 1
)

"%VENV_PY%" main.py

endlocal
