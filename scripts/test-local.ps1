param(
    [string]$TestPattern = "tests/**/*.ts",
    [string]$RpcUrl = "http://127.0.0.1:8899",
    [switch]$SkipPrepare
)

$RepoLinux = "/home/heis/agon/agon-protocol"
$RepoUnc = "\\wsl.localhost\Ubuntu\home\heis\agon\agon-protocol"
$WalletWindows = "\\wsl.localhost\Ubuntu\home\heis\agon\agon-protocol\keys\devnet-deployer.json"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$PrepareScript = "./scripts/prepare-local-test-suite.sh"
$MochaScript = ".\node_modules\mocha\bin\mocha"
$RuntimeSetupScript = ".\scripts\test-runtime-setup.cjs"

if (-not $SkipPrepare) {
    wsl.exe -d Ubuntu --cd $RepoLinux bash -lc $PrepareScript
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to prepare local validator and deploy the program."
    }
}

if (-not (Test-Path $NodeExe)) {
    throw "Node.exe not found at '$NodeExe'."
}

$env:ANCHOR_PROVIDER_URL = $RpcUrl
$env:ANCHOR_WALLET = $WalletWindows

Push-Location $RepoUnc
try {
    & $NodeExe --disable-warning=MODULE_TYPELESS_PACKAGE_JSON $MochaScript --require $RuntimeSetupScript --require ts-node/register --extension ts --timeout 1000000 $TestPattern
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
