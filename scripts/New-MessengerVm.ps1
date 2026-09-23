#Requires -RunAsAdministrator
<#
.SYNOPSIS
Creates the j-messenger Rocky Linux 10 Hyper-V VM on a host-only NAT network (10.77.0.0/24).
.DESCRIPTION
Phase Create:   internal switch + host IP + NAT (reused when present), then the VM
                (Gen 2, 1 vCPU, install RAM, 20 GiB VHDX, static MAC, installer ISO first).
Phase Finalize: after the guest is Off, detach the ISO, boot from disk, fix RAM at 1 GiB.
Phase Route:    enable IPv4 forwarding on the WSL and VM host adapters so WSL (NAT mode) reaches
                the VM. -Persist also registers a SYSTEM task that re-enables it every minute,
                because a WSL or Windows restart recreates the WSL adapter with forwarding off.
Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
.EXAMPLE
.\New-MessengerVm.ps1 -Phase Create -IsoPath D:\ISO\Rocky-10.2-x86_64-minimal.iso
.EXAMPLE
.\New-MessengerVm.ps1 -Phase Finalize
.EXAMPLE
.\New-MessengerVm.ps1 -Phase Route -Persist
#>
[CmdletBinding()]
param(
    [ValidateSet('Create', 'Finalize', 'Route')]
    [string] $Phase = 'Create',
    [string] $VmName = 'j-messenger-lab',
    [string] $SwitchName = 'JMessengerInternal',
    [string] $NatName = 'JMessengerNat',
    [string] $HostAddress = '10.77.0.1',
    [string] $NatPrefix = '10.77.0.0/24',
    [string] $MacAddress = '00155D004206',
    [ValidateRange(1536, 4096)]
    [int] $InstallMemoryMB = 2048,
    [ValidateRange(512, 4096)]
    [int] $FinalMemoryMB = 1024,
    [string] $IsoPath,
    [switch] $Persist,
    [string] $RootPath = (Join-Path $env:PUBLIC 'Documents\Hyper-V\j-messenger-lab')
)

$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop
$TaskName = 'j-messenger WSL-VM forwarding'

if ($Phase -eq 'Route') {
    $filter = "(`$_.InterfaceAlias -like 'vEthernet (WSL*' -or `$_.InterfaceAlias -eq 'vEthernet ($SwitchName)')"
    $targets = @(Get-NetIPInterface -AddressFamily IPv4 | Where-Object ([scriptblock]::Create($filter)))
    if ($targets.Count -lt 2) { throw 'WSL adapter or VM switch adapter not found. Start WSL and run Create first.' }
    $targets | Set-NetIPInterface -Forwarding Enabled
    if ($Persist) {
        $cmd = "Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $filter -and `$_.Forwarding -ne 'Enabled' } | Set-NetIPInterface -Forwarding Enabled"
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$cmd`""
        $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
        $boot = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($boot, $every) -Principal $principal `
            -Settings $settings -Force -Description 'Re-enable IPv4 forwarding between WSL and the j-messenger VM switch.' | Out-Null
        Write-Host "Registered scheduled task: $TaskName"
    }
    $targets | ForEach-Object { Write-Host "$($_.InterfaceAlias): forwarding enabled" }
    return
}

if ($Phase -eq 'Finalize') {
    $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
    if (-not $vm) { throw "VM not found: $VmName" }
    if ($vm.State -ne 'Off') { throw 'Shut down the guest and wait for VM state Off before Finalize.' }
    $disk = Get-VMHardDiskDrive -VMName $VmName | Select-Object -First 1
    if (-not $disk) { throw 'VM hard disk not found.' }
    Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $false -StartupBytes ($FinalMemoryMB * 1MB)
    Set-VM -Name $VmName -AutomaticCheckpointsEnabled $false
    Get-VMDvdDrive -VMName $VmName | Set-VMDvdDrive -Path $null
    Set-VMFirmware -VMName $VmName -FirstBootDevice $disk
    $cpu = (Get-VMProcessor -VMName $VmName).Count
    Write-Host "Finalized: $VmName; $cpu vCPU, fixed $FinalMemoryMB MiB RAM, boots from disk. Start-VM -Name '$VmName' when ready."
    return
}

if ([string]::IsNullOrWhiteSpace($IsoPath)) { throw 'Create requires -IsoPath.' }
$iso = (Resolve-Path -LiteralPath $IsoPath -ErrorAction Stop).ProviderPath
if ([IO.Path]::GetExtension($iso) -ine '.iso') { throw 'IsoPath must be an ISO file.' }
if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw "VM already exists: $VmName" }
if (Test-Path -LiteralPath $RootPath) {
    if (@(Get-ChildItem -LiteralPath $RootPath -Force).Count -gt 0) { throw "RootPath is not empty: $RootPath" }
} else {
    New-Item -ItemType Directory -Path $RootPath -Force | Out-Null
}

$switch = Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue
if ($switch) {
    if ($switch.SwitchType -ne 'Internal') { throw "Switch $SwitchName exists but is not Internal." }
} else {
    New-VMSwitch -Name $SwitchName -SwitchType Internal | Out-Null
}
$alias = "vEthernet ($SwitchName)"
$prefixLength = [int]($NatPrefix.Split('/')[1])
if (-not (Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object IPAddress -EQ $HostAddress)) {
    New-NetIPAddress -InterfaceAlias $alias -IPAddress $HostAddress -PrefixLength $prefixLength | Out-Null
}
$nat = Get-NetNat -Name $NatName -ErrorAction SilentlyContinue
if ($nat) {
    if ($nat.InternalIPInterfaceAddressPrefix -ne $NatPrefix) { throw "NAT $NatName uses another prefix." }
} else {
    New-NetNat -Name $NatName -InternalIPInterfaceAddressPrefix $NatPrefix | Out-Null
}

$vhdPath = Join-Path $RootPath "$VmName.vhdx"
New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($InstallMemoryMB * 1MB) `
    -NewVHDPath $vhdPath -NewVHDSizeBytes 20GB -Path $RootPath -SwitchName $SwitchName | Out-Null
Set-VMProcessor -VMName $VmName -Count 1 -CompatibilityForMigrationEnabled $false
Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $false -StartupBytes ($InstallMemoryMB * 1MB)
Set-VM -Name $VmName -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -AutomaticCheckpointsEnabled $false
Set-VMNetworkAdapter -VMName $VmName -StaticMacAddress $MacAddress
Add-VMDvdDrive -VMName $VmName -Path $iso
$dvd = Get-VMDvdDrive -VMName $VmName | Where-Object Path -EQ $iso | Select-Object -First 1
if (-not $dvd) { throw 'Could not attach installer ISO.' }
Set-VMFirmware -VMName $VmName -EnableSecureBoot On `
    -SecureBootTemplate 'MicrosoftUEFICertificateAuthority' -FirstBootDevice $dvd

Write-Host "Network: $SwitchName host $HostAddress, NAT $NatName $NatPrefix."
Write-Host "Created: $VmName (Gen 2, 1 vCPU, $InstallMemoryMB MiB install RAM, 20 GiB VHDX, MAC $MacAddress)."
Write-Host "Start-VM -Name '$VmName', install Rocky Linux 10 Minimal (IPv4 manual 10.77.0.10/24, gateway $HostAddress)."
Write-Host "Power the guest off after installation (do not reboot into the ISO), then run -Phase Finalize and -Phase Route -Persist."
