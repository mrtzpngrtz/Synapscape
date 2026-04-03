@echo off
title Synapscape Backend
echo Starting Synapscape backend on http://localhost:8000 ...

:: Add Anaconda Scripts to PATH so that uvx.exe is findable by subprocesses
set PATH=C:\Users\mrtz\anaconda3\Scripts;C:\Users\mrtz\anaconda3;%PATH%

:: Set your HuggingFace token to enable Llama text embeddings (optional)
:: 1. Accept license at https://huggingface.co/meta-llama/Llama-3.2-3B
:: 2. Get token at https://huggingface.co/settings/tokens
:: Copy this file to start_backend.bat and fill in your token:
set HF_TOKEN=YOUR_TOKEN_HERE

cd /d "%~dp0backend"
D:\tribe_env\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
