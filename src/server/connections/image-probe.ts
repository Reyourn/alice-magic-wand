import { randomInt, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { RuntimeImageAttachment } from '../../shared/types.js';

const palette = [
  { name:'red',rgb:[230,24,24] },
  { name:'green',rgb:[20,200,45] },
  { name:'blue',rgb:[25,50,235] },
] as const;
function crc32(bytes:Buffer):number {let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(name:string,body:Buffer):Buffer {const type=Buffer.from(name,'ascii'),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(body.length);checksum.writeUInt32BE(crc32(Buffer.concat([type,body])));return Buffer.concat([size,type,body,checksum]);}

/** Tiny generated test fixture; the random expected label stays server-side. */
export async function createImageProbe(directory:string):Promise<{image:RuntimeImageAttachment;expected:'red'|'green'|'blue'}> {
  const color=palette[randomInt(palette.length)]!,width=48,height=48,header=Buffer.alloc(13);
  header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let channel=0;channel<3;channel++)pixels[y*(width*3+1)+1+x*3+channel]=color.rgb[channel]!;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  const id=randomUUID(),path=join(directory,`${id}.png`);await writeFile(path,bytes);
  return {expected:color.name,image:{id,path,name:'connection-image.png',mimeType:'image/png',size:bytes.length,url:''}};
}

export function imageProbePassed(output:string,expected:string):boolean {
  const reported=[...new Set([...output.matchAll(/^\s*WORKBENCH_IMAGE_COLOR:\s*(red|green|blue)\s*$/gm)].map(match=>match[1]))];
  return reported.length===1&&reported[0]===expected;
}
