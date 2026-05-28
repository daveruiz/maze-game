param([switch]$Watch)

$projectPath = $PSScriptRoot
$wslPath = $projectPath -replace "C:\\", "/mnt/c/" -replace "\\", "/"

Write-Host "Building Dad's Nightmare..." -ForegroundColor Cyan

wsl bash -c @"
export NVM_DIR=~/.nvm && source ~/.nvm/nvm.sh
set -e
rm -rf ~/maze-build
mkdir ~/maze-build
cp '$wslPath/index.html' ~/maze-build/
cp '$wslPath/vite.config.ts' ~/maze-build/
cp '$wslPath/package.json' ~/maze-build/
cp '$wslPath/tsconfig.json' ~/maze-build/
cp -r '$wslPath/src' ~/maze-build/src
if [ -d '$wslPath/public' ]; then cp -r '$wslPath/public' ~/maze-build/public; fi
cd ~/maze-build
npm install --silent 2>/dev/null
npm run build 2>&1
cp -r ~/maze-build/dist/. '$wslPath/dist/'
echo '✓ Copied to dist/'
"@

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build complete!" -ForegroundColor Green
} else {
    Write-Host "Build failed." -ForegroundColor Red
}
