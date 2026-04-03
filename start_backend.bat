@echo off
title Brainmetatron Backend
echo Starting Brainmetatron backend on http://localhost:8000 ...

:: Add Anaconda Scripts to PATH so that uvx.exe is findable by subprocesses
set PATH=C:\Users\mrtz\anaconda3\Scripts;C:\Users\mrtz\anaconda3;%PATH%

cd /d "%~dp0backend"
D:\tribe_env\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
