param([Parameter(Mandatory=$true)][string]$OutputArchive)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
 if(-not(Test-Path -LiteralPath 'bin/routes')){throw 'Falta compilar routes para Linux amd64 con CGO_ENABLED=0.'}
 if(-not(Test-Path -LiteralPath 'dist/index.html')){throw 'Falta ejecutar npm run build.'}
 & tar -czf $OutputArchive package.json package-lock.json src dist bin/routes
 if($LASTEXITCODE -ne 0){throw 'Falló la creación del paquete de ejecución.'}
 Get-Item -LiteralPath $OutputArchive|Select-Object Name,Length
}finally{Pop-Location}
