import bwip from 'bwip-js';
const tries = [
  ['A HRI+parsefnc', '(01)06901234567892(17)271031(10)LOT01(21)SN0001', true],
  ['B 元素串^+parsefnc', '01069012345678921727103110LOT01^21SN0001', true],
  ['E HRI无parsefnc', '(01)06901234567892(17)271031(10)LOT01', false],
  ['F SSCC', '(00)069012340000000016', true],
];
for (const [name, text, parsefnc] of tries) {
  try {
    const buf = await bwip.toBuffer({ bcid: 'gs1-128', text, scale: 2, height: 10, parsefnc, includetext: false });
    console.log(name, 'OK bytes=' + buf.length);
  } catch (e) { console.log(name, 'ERR', String(e.message || e).slice(0, 140)); }
}
