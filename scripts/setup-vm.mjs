import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROFILE,
  normalizeProfile,
  renderNginx,
  shellSettings,
  originOf,
} from '../deploy/vm-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function createBundle(input, output) {
  const p = normalizeProfile(input),
    directory = path.resolve(output);
  try {
    await access(directory);
    throw new Error('설정 출력 폴더가 이미 있습니다. 새 경로를 선택하세요.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  await writeFile(
    path.join(directory, 'profile.json'),
    JSON.stringify(p, null, 2) + '\n',
  );
  await writeFile(
    path.join(directory, 'profile.env'),
    Object.entries(shellSettings(p))
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
  await writeFile(path.join(directory, 'nginx.conf'), renderNginx(p));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  await writeFile(
    path.join(directory, 'create-vm.ps1'),
    `# Run from an Administrator PowerShell after selecting your installer ISO.\nparam([Parameter(Mandatory)][string]$IsoPath)\n& ${quote(path.join(root, 'scripts/New-MessengerVm.ps1'))} -Phase Create -VmName ${quote(p.vmName)} -VmAddress ${quote(p.vmIp)} -HostAddress ${quote(p.gateway)} -NatPrefix ${quote(p.networkPrefix)} -SwitchName ${quote(p.switchName)} -NatName ${quote(p.natName)} -IsoPath $IsoPath\n`,
  );
  for (const file of [
    'vm-profile.mjs',
    'vm-profile.sh',
    'prepare-vm-guest.sh',
    'prepare-vm-tls.sh',
    'apply-vm-web.sh',
    'install-lab.sh',
    'j-messenger.service',
  ])
    await copyFile(path.join(root, 'deploy', file), path.join(directory, file));
  await writeFile(
    path.join(directory, 'plan.json'),
    JSON.stringify(
      {
        vmName: p.vmName,
        hostname: p.hostname,
        ip: p.vmIp,
        origin: originOf(p),
        backend: `${p.backendProtocol}://127.0.0.1:${p.backendPort}`,
        redirect: p.redirectHttp ? `${p.vmIp}:${p.httpPort}` : null,
        allowedSources: p.allowedSources,
        scope: [
          'Development-fixed lab only; production/mail environments are rejected',
          'Hyper-V VM creation is a separate Administrator command',
          'Guest preparation changes hostname/network profile/app account/packages',
          'TLS preparation keeps the CA private key on the operator WSL host',
          'Web apply replaces the dedicated VM nginx.conf, snapshots config and restarts app/nginx',
        ],
        applied: false,
      },
      null,
      2,
    ) + '\n',
  );
  return { directory, profile: p, origin: originOf(p) };
}
async function main() {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--output'].includes(args[i]) || !args[i + 1])
      throw new Error(
        '사용법: node scripts/setup-vm.mjs [--config profile.json] [--output 새폴더]',
      );
    options[args[i]] = args[i + 1];
  }
  let p;
  if (options['--config'])
    p = JSON.parse(
      (await readFile(options['--config'], 'utf8')).replace(/^\uFEFF/, ''),
    );
  else {
    if (!stdin.isTTY)
      throw new Error('대화형 터미널 또는 --config 입력이 필요합니다.');
    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write(
      '개발용 메신저 VM 설정입니다. 생성 후 별도 명령으로 적용합니다.\n',
    );
    const ask = async (label, initial) =>
      (await rl.question(`${label} [${initial}]: `)).trim() || String(initial);
    try {
      p = { ...DEFAULT_PROFILE };
      p.vmName = await ask('Hyper-V VM 이름', p.vmName);
      p.hostname = await ask(
        'Linux hostname / backend 인증서 DNS 이름',
        p.vmName.toLowerCase(),
      );
      p.vmIp = await ask('VM 사설 IPv4', p.vmIp);
      p.networkPrefix = await ask('NAT 서브넷 CIDR', p.networkPrefix);
      p.gateway = await ask('Windows NAT gateway IPv4', p.gateway);
      p.dns = (await ask('DNS IPv4 목록(쉼표 구분)', p.dns.join(',')))
        .split(',')
        .map((v) => v.trim());
      p.interfaceName = await ask('게스트 NIC 이름', p.interfaceName);
      p.switchName = await ask('Hyper-V Internal Switch 이름', p.switchName);
      p.natName = await ask('기존/신규 WinNAT 이름', p.natName);
      p.protocol = await ask(
        '외부 방식: https(암호화) / http(개발 시험)',
        p.protocol,
      );
      p.publicPort = Number(
        await ask('외부 공개 포트', p.protocol === 'http' ? 80 : 443),
      );
      p.backendProtocol = await ask(
        'VM 내부 Node 방식: https / http',
        p.protocol,
      );
      p.backendPort = Number(
        await ask(
          'VM 내부 Node 포트',
          p.backendProtocol === 'https' ? 3443 : 3080,
        ),
      );
      const redirect = await ask('HTTP→HTTPS redirect: yes / no', 'no');
      if (!['yes', 'no'].includes(redirect))
        throw new Error('redirect는 yes 또는 no입니다.');
      p.redirectHttp = redirect === 'yes';
      if (p.redirectHttp)
        p.httpPort = Number(await ask('redirect용 HTTP 포트', 80));
      p.appUser = await ask('게스트 앱 계정(관리자 권한 없음)', p.appUser);
      p.sshAppAlias = await ask('WSL 앱 계정 SSH alias', p.sshAppAlias);
      p.sshAdminAlias = await ask('WSL 관리자 SSH alias', p.sshAdminAlias);
      p.allowedSources = (
        await ask(
          '접속 허용 사설 CIDR 목록',
          `${p.networkPrefix},172.16.0.0/12`,
        )
      )
        .split(',')
        .map((v) => v.trim());
      p.firewallZone = await ask('firewalld 전용 zone', p.firewallZone);
    } finally {
      rl.close();
    }
  }
  const normalized = normalizeProfile(p);
  const output =
    options['--output'] ||
    path.join(root, '.tools/vm-setup', `${normalized.vmName}-${Date.now()}`);
  const result = await createBundle(normalized, output);
  stdout.write(
    `설정 생성 완료: ${result.directory}\n접속 주소: ${result.origin}\n내부 Node: ${result.profile.backendProtocol}://127.0.0.1:${result.profile.backendPort}\nplan.json을 확인하고 상세 문서18의 순서로 적용하세요. 현재 VM은 변경되지 않았습니다.\n`,
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
