@echo off
setlocal

set "WSL_REPO=/home/heis/agon/agon-protocol"
set "WINDOW_TITLE=Agon Protocol Demo"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath cmd.exe -WorkingDirectory '\\wsl$\Ubuntu\home\heis\agon\agon-protocol' -ArgumentList '/k','title %WINDOW_TITLE% && wsl.exe -d Ubuntu -- bash -lc ""cd %WSL_REPO% && ./scripts/agon-protocol-demo.sh""'"
