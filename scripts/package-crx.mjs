import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

function uint32(value) {
  const packed = Buffer.alloc(4);
  packed.writeUInt32LE(value);
  return packed;
}

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  return Buffer.from([...bytes, value]);
}

function bytesField(number, data) {
  return Buffer.concat([varint((number << 3) | 2), varint(data.length), data]);
}

const [output, flag] = process.argv.slice(2);
if (!output?.endsWith('.crx') || (flag && flag !== '--ephemeral')) {
  throw new Error('用法：node scripts/package-crx.mjs <输出.crx> [--ephemeral]');
}
const pem = process.env.CRX_PRIVATE_KEY;
const expectedId = process.env.CRX_EXTENSION_ID;
delete process.env.CRX_PRIVATE_KEY;
if (flag !== '--ephemeral' && (!pem || !/^[a-p]{32}$/.test(expectedId ?? ''))) {
  throw new Error('签名需要 CRX_PRIVATE_KEY 和预期的 CRX_EXTENSION_ID。');
}

const privateKey = flag === '--ephemeral'
  ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  : createPrivateKey(pem);
if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) {
  throw new Error('需要至少 2048 位的 RSA 签名密钥。');
}

const archive = execFileSync('git', ['archive', '--format=zip', 'HEAD', 'manifest.json', 'src/', 'assets/']);
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const id = createHash('sha256').update(publicKey).digest().subarray(0, 16);
const extensionId = id.toString('hex').replace(/[0-9a-f]/g, digit => 'abcdefghijklmnop'[parseInt(digit, 16)]);
if (flag !== '--ephemeral' && extensionId !== expectedId) {
  throw new Error('签名密钥对应的扩展 ID 已改变，停止构建。');
}

// CRX3 头部使用 protobuf，签名覆盖 SignedData 和完整 ZIP。
const signedData = bytesField(1, id);
const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0'), uint32(signedData.length), signedData, archive]);
const proof = Buffer.concat([bytesField(1, publicKey), bytesField(2, sign('sha256', payload, privateKey))]);
const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedData)]);
const crx = Buffer.concat([Buffer.from('Cr24'), uint32(3), uint32(header.length), header, archive]);
writeFileSync(output, crx, { flag: 'wx' });
console.log(`CRX3 扩展 ID：${extensionId}`);
console.log(`SHA256：${createHash('sha256').update(crx).digest('hex')}`);
