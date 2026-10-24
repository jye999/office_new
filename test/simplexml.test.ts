// Goldens: print_r(simplexml_load_string($xml)) / json_encode(...) in the old app's php:7.4-cli container.
import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/lib/ups.js';
import { phpStrEq, sxBool, sxCount, sxGet, sxIsset, sxJsonValue, sxPrintR, sxText } from '../src/lib/simplexml.js';

const X1 = '<R xmlns="urn:x"><Ack>Success</Ack><Item><ID>1</ID><Pics><U>a</U><U>b</U></Pics><E/><A k="v">t</A><B k="v"/></Item><Q>1</Q><Q>2</Q></R>';
const P1 = `SimpleXMLElement Object
(
    [Ack] => Success
    [Item] => SimpleXMLElement Object
        (
            [ID] => 1
            [Pics] => SimpleXMLElement Object
                (
                    [U] => Array
                        (
                            [0] => a
                            [1] => b
                        )

                )

            [E] => SimpleXMLElement Object
                (
                )

            [A] => t
            [B] => SimpleXMLElement Object
                (
                    [@attributes] => Array
                        (
                            [k] => v
                        )

                )

        )

    [Q] => Array
        (
            [0] => 1
            [1] => 2
        )

)
`;
const J1 = '{"Ack":"Success","Item":{"ID":"1","Pics":{"U":["a","b"]},"E":{},"A":"t","B":{"@attributes":{"k":"v"}}},"Q":["1","2"]}';

describe('SimpleXML helpers match PHP 7.4', () => {
  it('print_r and json shapes', () => {
    const x = parseXml(X1);
    expect(sxPrintR(x)).toBe(P1);
    expect(JSON.stringify(sxJsonValue(x))).toBe(J1);
    expect(sxPrintR(parseXml('<R><Ack>Failure</Ack></R>'))).toBe('SimpleXMLElement Object\n(\n    [Ack] => Failure\n)\n');
    expect(sxPrintR(parseXml('<R><A><B><C>deep</C></B></A><T>x &amp; y</T></R>'))).toBe(
      'SimpleXMLElement Object\n(\n    [A] => SimpleXMLElement Object\n        (\n            [B] => SimpleXMLElement Object\n                (\n                    [C] => deep\n                )\n\n        )\n\n    [T] => x & y\n)\n',
    );
  });

  it('accessors', () => {
    const r = parseXml('<R><Pics><U>a</U><U>b</U></Pics><V/></R>');
    expect(sxCount(sxGet(r, 'Pics', 'U'))).toBe(2);
    expect(sxText(sxGet(r, 'Pics', 'U'))).toBe('a'); // (string) of a list = first element
    expect(sxIsset(sxGet(r, 'Pics', 'U'))).toBe(true);
    expect(sxIsset(sxGet(r, 'X'))).toBe(false);
    expect(sxBool(sxGet(r, 'Nope'))).toBe(false);
    expect(sxBool(sxGet(r, 'V'))).toBe(false); // empty element is falsy
    expect(sxBool(sxGet(r, 'Pics'))).toBe(true);
    expect(phpStrEq('1.0', '1')).toBe(true);
    expect(phpStrEq('a', 'A')).toBe(false);
  });
});
