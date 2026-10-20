@echo off
rem Music Trainer - start the app: database migration, API + web app, GPU worker.
rem Double-click this file, or run it from a terminal. Close the two windows to stop.
setlocal
cd /d "%~dp0"

if not exist "backend\.venv\Scripts\python.exe" (
  echo Backend is not installed. See README.md, Quick start step 1.
  pause & exit /b 1
)
if not exist "engine\.venv\Scripts\python.exe" (
  echo The engine ^(Applio^) is not installed. See README.md, Quick start step 2.
  pause & exit /b 1
)
if not exist "frontend\dist\index.html" (
  echo Building the web app once...
  pushd frontend
  call npm run build || (echo Frontend build failed. & popd & pause & exit /b 1)
  popd
)

pushd backend
.venv\Scripts\alembic.exe upgrade head || (echo Database migration failed. & popd & pause & exit /b 1)
start "Music Trainer - API" .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --timeout-keep-alive 30
start "Music Trainer - GPU worker" .venv\Scripts\python.exe -m app.worker.loop
popd

rem give the API a moment, then open the app
timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:8000/
echo Music Trainer is running at http://127.0.0.1:8000/
endlocal
