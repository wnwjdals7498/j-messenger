#Requires -RunAsAdministrator
<#
.SYNOPSIS
Creates the j-messenger Rocky Linux Hyper-V VM, then fixes RAM at 1 GiB after installation.
.EXAMPLE
.\New-MessengerVm.ps1 -Phase Create -IsoPath C:\ISO\Rocky-10-x86_64-minimal.iso -SwitchName LabExternal -AdapterName Ethernet
.EXAMPLE
.\New-MessengerVm.ps1 -Phase Finalize -SwitchName LabExternal
#>
[CmdletBinding()]
param(
    [ValidateSet('Create', 'Finalize')]
    [string] $Phase = 'Create',
    [string] $VmName = 'j-messenger-lab',
    [string] $SwitchName = 'JMessengerExternal',
    [string] $AdapterName,
    [string] $IsoPath,
    [string] $RootPath = (Join-Path $env:PUBLIC 'Documents\Hyper-V\j-messenger-lab')
)

$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop

if ($Phase -eq 'Finalize') {
    $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
    if (-not $vm) { throw "VM not found: $VmName" }
    if ($vm.State -ne 'Off') { throw 'Shut down the guest and wait for VM state Off before Finalize.' }
    $disk = Get-VMHardDiskDrive -VMName $VmName | Select-Object -First 1
    if (-not $disk) { throw 'VM hard disk not found.' }
    Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $false -StartupBytes 1GB
    Get-VMDvdDrive -VMName $VmName | Set-VMDvdDrive -Path $null
    Set-VMFirmware -VMName $VmName -FirstBootDevice $disk
    Write-Host "Finalized: $VmName; 1 vCPU and fixed 1 GiB RAM. Start-VM -Name '$VmName' when ready."
    return
}

if ([string]::IsNullOrWhiteSpace($IsoPath)) { throw 'Create requires -IsoPath.' }
$iso = (Resolve-Path -LiteralPath $IsoPath -ErrorAction Stop).ProviderPath
if ([IO.Path]::GetExtension($iso) -ine '.iso') { throw 'IsoPath must be an ISO file.' }
if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw "VM already exists: $VmName" }

if (Test-Path -LiteralPath $RootPath) {
    $rootItems = @(Get-ChildItem -LiteralPath $RootPath -Force)
    if ($rootItems.Count -gt 0) { throw "RootPath is not empty: $RootPath" }
} else {
    New-Item -ItemType Directory -Path $RootPath -Force | Out-Null
}

$existingSwitch = Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue
if ($existingSwitch) {
    if ($existingSwitch.SwitchType -ne 'External') { throw "Switch $SwitchName is not External." }
} else {
    if ([string]::IsNullOrWhiteSpace($AdapterName)) {
        throw 'Switch does not exist. Pass -AdapterName for an explicitly chosen physical NIC.'
    }
    $adapter = Get-NetAdapter -Name $AdapterName -ErrorAction Stop
    if ($adapter.Status -ne 'Up') { throw "Adapter is not Up: $AdapterName" }
    Write-Warning 'Creating an external switch may briefly interrupt the selected adapter.'
    New-VMSwitch -Name $SwitchName -NetAdapterName $AdapterName -AllowManagementOS $true | Out-Null
}

$vhdPath = Join-Path $RootPath "$VmName.vhdx"
New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 2GB `
    -NewVHDPath $vhdPath -NewVHDSizeBytes 20GB `
    -Path $RootPath -SwitchName $SwitchName | Out-Null
Set-VMProcessor -VMName $VmName -Count 1
Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $false -StartupBytes 2GB
Set-VM -Name $VmName -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
$dvd = Get-VMDvdDrive -VMName $VmName | Select-Object -First 1
if ($dvd) {
    $dvd | Set-VMDvdDrive -Path $iso
} else {
    Add-VMDvdDrive -VMName $VmName -Path $iso
}
$dvd = Get-VMDvdDrive -VMName $VmName | Where-Object Path -EQ $iso | Select-Object -First 1
if (-not $dvd) { throw 'Could not attach installer ISO.' }
Set-VMFirmware -VMName $VmName -EnableSecureBoot On `
    -SecureBootTemplate 'MicrosoftUEFICertificateAuthority' -FirstBootDevice $dvd

Write-Host "Created: $VmName (Gen 2, 1 vCPU, 2 GiB install RAM, 20 GiB VHDX)."
Write-Host "Start-VM -Name '$VmName' and install Rocky Linux 10 Minimal."
Write-Host 'The fixed guest IP is set inside Rocky with Configure-GuestNetwork.sh.'
Write-Host "After installation, shut down the guest and run this script with -Phase Finalize -VmName '$VmName'."
