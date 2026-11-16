param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$cfg=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if($cfg.sqlDatabase -ne 'talsory' -or -not $cfg.resourceGroup.StartsWith('rg-talsory-') -or -not $cfg.sqlServer.StartsWith('sql-talsory-')){throw 'El destino no pertenece al entorno aislado Talsory.'}
function AzNone {param([string[]]$Arguments) & az @Arguments --only-show-errors --output none; if($LASTEXITCODE -ne 0){throw ('Falló Azure: '+($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' '))}}
AzNone -Arguments @('account','set','--subscription',$cfg.subscriptionId)
foreach($provider in @('Microsoft.App','Microsoft.Sql','Microsoft.Storage')){
 AzNone -Arguments @('provider','register','--namespace',$provider,'--wait')
}
AzNone -Arguments @('group','create','--name',$cfg.resourceGroup,'--location',$cfg.location,'--tags','project=Talsory','environment=demo','data=synthetic')
Write-Output 'Grupo exclusivo Talsory preparado.'
$serverExists=& az sql server list --resource-group $cfg.resourceGroup --query "[?name=='$($cfg.sqlServer)'].name | [0]" --output tsv --only-show-errors
if(-not $serverExists){AzNone -Arguments @('sql','server','create','--resource-group',$cfg.resourceGroup,'--name',$cfg.sqlServer,'--location',$cfg.location,'--admin-user',$cfg.sqlAdminUser,'--admin-password',$cfg.sqlAdminPassword,'--minimal-tls-version','1.2')}
Write-Output 'Servidor SQL exclusivo Talsory preparado.'
$databaseExists=& az sql db list --resource-group $cfg.resourceGroup --server $cfg.sqlServer --query "[?name=='talsory'].name | [0]" --output tsv --only-show-errors
if(-not $databaseExists){AzNone -Arguments @('sql','db','create','--resource-group',$cfg.resourceGroup,'--server',$cfg.sqlServer,'--name','talsory','--edition','GeneralPurpose','--family','Gen5','--capacity','2','--min-capacity','0.5','--compute-model','Serverless','--use-free-limit','--free-limit-exhaustion-behavior','AutoPause','--max-size','32GB','--auto-pause-delay','60')}
Write-Output 'BD talsory con cuota gratuita y pausa al agotarla preparada.'
$ip=(Invoke-RestMethod -Uri 'https://api.ipify.org').Trim()
if($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$'){throw 'No se pudo identificar una IPv4 de administración.'}
AzNone -Arguments @('sql','server','firewall-rule','create','--resource-group',$cfg.resourceGroup,'--server',$cfg.sqlServer,'--name','TalsorySetupOnly','--start-ip-address',$ip,'--end-ip-address',$ip)
$env:SQL_SERVER=$cfg.sqlServer+'.database.windows.net';$env:SQL_DATABASE='talsory';$env:SQL_USER=$cfg.sqlAdminUser;$env:SQL_PASSWORD=$cfg.sqlAdminPassword;$env:APP_SQL_PASSWORD=$cfg.appSqlPassword
Push-Location (Split-Path -Parent $PSScriptRoot)
try {& node scripts/setup-db.js;if($LASTEXITCODE -ne 0){throw 'Falló la preparación de la nueva BD talsory.'}}finally{Pop-Location;Remove-Item Env:SQL_PASSWORD,Env:APP_SQL_PASSWORD -ErrorAction SilentlyContinue}
Write-Output 'Esquema y datos ficticios preparados exclusivamente en la BD nueva.'
