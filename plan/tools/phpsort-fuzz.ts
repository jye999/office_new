import { phpUsort } from '../../src/lib/phpSort.ts';
import { execFileSync } from 'node:child_process';
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const cases: number[][] = [];
for (const n of [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,25,30,33,40,64,100,300]) for (let r = 0; r < 12; r++) { const m = 1 + Math.floor(rnd() * (r % 3 === 0 ? 3 : 8)); cases.push(Array.from({ length: n }, () => Math.floor(rnd() * m))); }
const php = `$cases=json_decode(file_get_contents('php://stdin'),true);$out=[];foreach($cases as $c){$a=[];foreach($c as $i=>$k){$a[]=[$k,$i];} usort($a,function($x,$y){return strcmp((string)$x[0],(string)$y[0]);});$out[]=array_map(function($p){return $p[1];},$a);}echo json_encode($out);`;
const res = JSON.parse(execFileSync('docker', ['exec', '-i', 'office', 'php', '-r', php], { input: JSON.stringify(cases) }).toString());
let bad = 0;
cases.forEach((c, ci) => {
  const a = c.map((k, i) => [k, i] as [number, number]);
  phpUsort(a, (x, y) => (String(x[0]) < String(y[0]) ? -1 : String(x[0]) > String(y[0]) ? 1 : 0));
  const got = a.map((p) => p[1]);
  if (JSON.stringify(got) !== JSON.stringify(res[ci])) { bad++; if (bad < 4) console.log('MISMATCH n=' + c.length, JSON.stringify(c), '\nphp', JSON.stringify(res[ci]), '\nts ', JSON.stringify(got)); }
});
console.log('cases', cases.length, 'mismatches', bad);
