@echo off
rem GeoSpaX web edition: serves the app at http://localhost:8080 to any browser on this PC.
rem Your maps live in %USERPROFILE%\GeoSpaX (the same folders the desktop app uses).
rem Other devices on your network: run  geospax-web.cmd --host 0.0.0.0  (Windows will ask about the firewall);
rem the server then prints a link with an access token: open that link on the other device.
setlocal
set "GX=%USERPROFILE%\GeoSpaX"
if not exist "%GX%\Data" mkdir "%GX%\Data"
if not exist "%GX%\Inbox" mkdir "%GX%\Inbox"
start "" http://localhost:8080
"%~dp0geospax-server.exe" --data "%GX%\Data" --inbox "%GX%\Inbox" --state-dir "%GX%\.geospax" --host 127.0.0.1 --port 8080 %*
