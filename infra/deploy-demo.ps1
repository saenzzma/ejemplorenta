param(
 [Parameter(Mandatory=$true)][string]$ConfigPath,
 [Parameter(Mandatory=$true)][string]$RuntimeArchive,
 [string[]]$SqlAllowedOutboundIps=@()
)
$ErrorActionPreference='Stop'
$cfg=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if($cfg.sqlDatabase -ne 'talsory' -or -not $cfg.resourceGroup.StartsWith('rg-talsory-')){throw 'Destino fuera del entorno autorizado.'}
function AzNone {param([string[]]$Arguments) & az @Arguments --only-show-errors --output none;if($LASTEXITCODE -ne 0){throw ('Falló Azure: '+($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' '))}}
function AzJson {param([string[]]$Arguments) $result=& az @Arguments --only-show-errors --output json;if($LASTEXITCODE -ne 0){throw ('Falló Azure: '+($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' '))};return ($result | ConvertFrom-Json)}
AzNone -Arguments @('account','set','--subscription',$cfg.subscriptionId)
AzNone -Arguments @('provider','register','--namespace','Microsoft.Storage','--wait')
$storageName='st'+$cfg.registry
$storage=AzJson -Arguments @('storage','account','create','--resource-group',$cfg.resourceGroup,'--name',$storageName,'--location',$cfg.location,'--sku','Standard_LRS','--kind','StorageV2','--access-tier','Hot','--min-tls-version','TLS1_2','--https-only','true','--allow-blob-public-access','false','--tags','project=Talsory','environment=demo')
Write-Output 'Almacenamiento privado de la demostración preparado; sin registro de contenedores de pago.'
$storageKeys=AzJson -Arguments @('storage','account','keys','list','--resource-group',$cfg.resourceGroup,'--account-name',$storageName)
$env:AZURE_STORAGE_ACCOUNT=$storageName;$env:AZURE_STORAGE_KEY=$storageKeys[0].value
AzNone -Arguments @('storage','container','create','--name','runtime','--public-access','off','--auth-mode','key')
AzNone -Arguments @('storage','blob','upload','--container-name','runtime','--name','talsory-demo.tgz','--file',(Resolve-Path -LiteralPath $RuntimeArchive).Path,'--overwrite','true','--auth-mode','key')
$expiry=[DateTime]::UtcNow.AddHours(4).ToString('yyyy-MM-ddTHH:mmZ')
$sas=& az storage blob generate-sas --container-name runtime --name talsory-demo.tgz --permissions r --expiry $expiry --https-only --auth-mode key --output tsv --only-show-errors
if($LASTEXITCODE -ne 0){throw 'No se pudo preparar el acceso temporal al paquete.'}
$packageUrl="https://$storageName.blob.core.windows.net/runtime/talsory-demo.tgz?$sas"
Remove-Item Env:AZURE_STORAGE_KEY -ErrorAction SilentlyContinue
$environmentExists=& az containerapp env list --resource-group $cfg.resourceGroup --query "[?name=='$($cfg.environment)'].name | [0]" --output tsv --only-show-errors
if(-not $environmentExists){AzNone -Arguments @('containerapp','env','create','--resource-group',$cfg.resourceGroup,'--name',$cfg.environment,'--location',$cfg.location,'--logs-destination','none','--enable-workload-profiles','false','--tags','project=Talsory','environment=demo')}
$environment=AzJson -Arguments @('containerapp','env','show','--resource-group',$cfg.resourceGroup,'--name',$cfg.environment)
$boot='set -eu; mkdir -p /tmp/talsory; cd /tmp/talsory; wget -qO runtime.tgz "$PACKAGE_URL"; tar -xzf runtime.tgz; chmod 700 bin/routes; npm ci --omit=dev --ignore-scripts --no-audit --no-fund; exec node src/demo.js'
$appName='talsory-demo'
$app=@{
 name=$appName;type='Microsoft.App/containerApps';location=$cfg.location
 tags=@{project='Talsory';environment='demo';data='synthetic';mode='short-lived'}
 properties=@{
  managedEnvironmentId=$environment.id
  configuration=@{
   activeRevisionsMode='Single'
   ingress=@{external=$true;targetPort=8080;transport='auto';allowInsecure=$false}
   secrets=@(
    @{name='package-url';value=$packageUrl},@{name='sql-password';value=$cfg.appSqlPassword},
    @{name='jwt-secret';value=$cfg.jwtSecret},@{name='internal-key';value=$cfg.internalKey},
    @{name='reviewer-hash';value=$cfg.reviewerHash}
   )
  }
  template=@{
   containers=@(@{
    name='demo';image='docker.io/library/node:24-alpine';command=@('/bin/sh');args=@('-c',$boot)
    resources=@{cpu=0.5;memory='1Gi'}
    env=@(
     @{name='PORT';value='8080'},@{name='NODE_ENV';value='production'},
     @{name='SQL_SERVER';value=($cfg.sqlServer+'.database.windows.net')},@{name='SQL_DATABASE';value='talsory'},
     @{name='SQL_USER';value='talsory_app'},@{name='SQL_PASSWORD';secretRef='sql-password'},
     @{name='JWT_SECRET';secretRef='jwt-secret'},@{name='INTERNAL_KEY';secretRef='internal-key'},
     @{name='REVIEWER_HASH';secretRef='reviewer-hash'},@{name='PACKAGE_URL';secretRef='package-url'}
    )
    probes=@(
     @{type='Startup';httpGet=@{path='/health';port=8080};initialDelaySeconds=10;periodSeconds=5;failureThreshold=60},
     @{type='Readiness';httpGet=@{path='/health';port=8080};periodSeconds=10;failureThreshold=3},
     @{type='Liveness';httpGet=@{path='/health';port=8080};initialDelaySeconds=60;periodSeconds=30;failureThreshold=3}
    )
   })
   scale=@{minReplicas=0;maxReplicas=1;rules=@(@{name='http';http=@{metadata=@{concurrentRequests='10'}}})}
  }
 }
}
$privateDir=Split-Path -Parent (Resolve-Path -LiteralPath $ConfigPath).Path
$appFile=Join-Path $privateDir 'containerapp-private.json'
$app | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $appFile -Encoding utf8
AzNone -Arguments @('containerapp','create','--resource-group',$cfg.resourceGroup,'--name',$appName,'--yaml',$appFile)
$deployed=AzJson -Arguments @('containerapp','show','--resource-group',$cfg.resourceGroup,'--name',$appName)
$outbound=@($deployed.properties.outboundIpAddresses|Where-Object{$_})
if(-not $outbound){$outbound=@($environment.properties.staticIp|Where-Object{$_})}
if(-not $outbound){$outbound=@($SqlAllowedOutboundIps|Where-Object{$_})}
if(-not $outbound){
 throw 'Este entorno Express no publica la IP de salida. Obtén la IPv4 con az containerapp exec --command "wget -qO- https://api.ipify.org" y proporciona -SqlAllowedOutboundIps. No se habilitó acceso SQL para todo Azure.'
}
$index=0
foreach($ip in ($outbound|Sort-Object -Unique)){
 if($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$'){throw 'Azure no devolvió una IPv4 de salida válida. No se amplió el firewall SQL.'}
 AzNone -Arguments @('sql','server','firewall-rule','create','--resource-group',$cfg.resourceGroup,'--server',$cfg.sqlServer,'--name',('TalsoryApp'+$index),'--start-ip-address',$ip,'--end-ip-address',$ip)
 $index++
}
$result=@{url=('https://'+$deployed.properties.configuration.ingress.fqdn);resourceGroup=$cfg.resourceGroup;app=$appName;location=$cfg.location;mode='sql-outbox-local-worker';packageAccessExpiresUtc=$expiry;usesServiceBus=$false;usesPaidContainerRegistry=$false;realPayments=$false}
$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $privateDir 'deployment-result.json') -Encoding utf8
$result|ConvertTo-Json
