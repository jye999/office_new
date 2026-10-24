import re,sys,difflib
def norm(B):
    s=open(f'/tmp/pg{B}.html').read().replace(f'localhost:{B}','H')
    s=re.sub(r"<link rel='stylesheet'[^\n]*_debugbar.*?</script>\s*(?=</body>)",'',s,flags=re.S)
    s=re.sub(r'(value="|\')[0-9a-zA-Z]{20,40}("|\')',r'\1T\2',s)
    return s.split()
a,b=norm(6999),norm(7000)
sm=difflib.SequenceMatcher(None,a,b,autojunk=False)
n=0
for op,i1,i2,j1,j2 in sm.get_opcodes():
    if op=='equal': continue
    n+=1
    if n>int(sys.argv[1]): break
    print(op,'| OLD:',' '.join(a[max(i1-3,0):i2+2])[:260]); print('     | NEW:',' '.join(b[max(j1-3,0):j2+2])[:260])
print('hunks',n)
