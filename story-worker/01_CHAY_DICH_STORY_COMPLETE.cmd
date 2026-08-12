@echo off
chcp 65001 >nul
cd /d "%~dp0"
title GBFR Story Complete Worker v1.8

echo ============================================================
echo  GBFR STORY COMPLETE WORKER v1.8 - FINAL RECOVERY HOTFIX
echo ============================================================
echo.
echo Yeu cau:
echo - Mo LM Studio va bat Local Server tai cong 1234.
echo - Qwen3.5 9B da duoc tai san trong LM Studio.
echo - Co the dung giua chung; chay lai file nay se tiep tuc checkpoint.
echo - Cau bi QA tu choi se duoc sua lai ngay, khong de loi da cuu kich hoat dung.
echo - Loi cu trong failure log duoc tach khoi pilot va xu ly o hang cuu cuoi.
echo - Ten dien vien TXT_CV duoc giu English va khong gui Qwen dich sai.
echo - Checkpoint TXT_CV da bi model sua se tu dong duoc khoi phuc ve English.
echo - Cum "%% dua tren" khong con bi nhan nham thanh token ky thuat "%% d".
echo - Het batch moi thi Worker chuyen thang sang hang cuu, khong dung oan.
echo - Worker chi chay tiep sau khi pilot 100 muc dat cong an toan.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo KHONG TIM THAY NODE.JS.
  echo Hay mo Antigravity terminal tai thu muc nay va chay lai file.
  pause
  exit /b 1
)

node worker.mjs
echo.
pause
