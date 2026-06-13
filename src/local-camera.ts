import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface CameraCaptureResult {
  filePath: string;
  deviceName: string;
}

const MIN_PHOTO_BYTES = 10 * 1024;

export function isCameraCaptureRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const compact = trimmed.replace(/\s+/g, '').toLowerCase();
  if (compact === '/camera' || compact === '/photo' || compact === '/拍照') {
    return true;
  }

  const hasCameraWord = /(相机|摄像头|camera|webcam)/i.test(trimmed);
  const hasCaptureWord = /(拍照|拍一张|拍张|照一张|拍照片|抓拍|take\s+(a\s+)?(photo|picture))/i.test(trimmed);
  const hasSendIntent = /(发给我|发我|发送|传给我|给我|send|share)/i.test(trimmed);

  return hasCameraWord && hasCaptureWord && hasSendIntent;
}

export function capturePhoto(): CameraCaptureResult {
  const ffmpeg = resolveFfmpeg();
  const deviceName = selectCameraDevice(ffmpeg);
  const filePath = makePhotoPath();
  mkdirSync(dirname(filePath), { recursive: true });

  const args = process.platform === 'win32'
    ? [
        '-hide_banner',
        '-y',
        '-f',
        'dshow',
        '-video_size',
        '1280x720',
        '-framerate',
        '30',
        '-i',
        `video=${deviceName}`,
        '-frames:v',
        '1',
        '-update',
        '1',
        '-q:v',
        '2',
        filePath,
      ]
    : [
        '-hide_banner',
        '-y',
        '-f',
        'avfoundation',
        '-i',
        deviceName,
        '-frames:v',
        '1',
        '-update',
        '1',
        '-q:v',
        '2',
        filePath,
      ];

  const result = spawnSync(ffmpeg, args, {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`拍照失败: ${result.error.message}`);
  }

  if (!existsSync(filePath)) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`拍照失败，照片文件没有生成${output ? `: ${output}` : ''}`);
  }

  const stat = statSync(filePath);
  if (stat.size < MIN_PHOTO_BYTES) {
    throw new Error(`拍照失败，照片文件异常偏小: ${stat.size} bytes`);
  }

  return { filePath, deviceName };
}

function resolveFfmpeg(): string {
  const candidates = [
    process.env.FFMPEG_PATH,
    process.env.WECHAT_CODEX_FFMPEG,
    process.platform === 'win32' ? String.raw`C:\ffmpeg\bin\ffmpeg.exe` : undefined,
    process.platform === 'win32' ? String.raw`C:\ProgramData\chocolatey\bin\ffmpeg.exe` : undefined,
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const lookupCommand = process.platform === 'win32' ? 'where.exe' : 'which';
  const lookup = spawnSync(lookupCommand, ['ffmpeg'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });

  const firstMatch = lookup.stdout?.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (firstMatch && existsSync(firstMatch)) return firstMatch;

  throw new Error('未找到 ffmpeg，无法调用摄像头拍照。');
}

function selectCameraDevice(ffmpeg: string): string {
  const configured = process.env.WECHAT_CODEX_CAMERA_DEVICE?.trim();
  if (configured) return configured;

  if (process.platform !== 'win32') {
    return '0';
  }

  const devices = listWindowsVideoDevices(ffmpeg);
  if (devices.length === 0) {
    return 'Integrated Camera';
  }

  return (
    devices.find(device => /^Integrated Camera$/i.test(device))
    ?? devices.find(device => /integrated|内置/i.test(device))
    ?? devices.find(device => !/(虚拟|virtual|obs|screen|capture)/i.test(device))
    ?? devices[0]
  );
}

function listWindowsVideoDevices(ffmpeg: string): string[] {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });

  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const devices: string[] = [];
  const regex = /^\[dshow[^\]]*\]\s+"([^"]+)"\s+\(video\)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    devices.push(match[1]);
  }
  return devices;
}

function makePhotoPath(): string {
  const dir = join(homedir(), 'Pictures', 'Camera Roll');
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return join(dir, `wechat-camera-${stamp}.jpg`);
}

export function describeCameraResult(result: CameraCaptureResult): string {
  return `已拍照: ${basename(result.filePath)}\n${result.filePath}`;
}
