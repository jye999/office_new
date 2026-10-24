set -e
cd ~/code/office_new
PARITY_EMAIL=$(grep ^PARITY_EMAIL= .env|cut -d= -f2-); PARITY_PASSWORD=$(grep ^PARITY_PASSWORD= .env|cut -d= -f2-)
for B in 6999 7000; do
  J=/tmp/jar$B; rm -f $J
  T=$(curl -s -c $J http://localhost:$B/login | grep -o 'name="_token" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
  curl -s -b $J -c $J -o /dev/null -d "email=$PARITY_EMAIL" --data-urlencode "password=$PARITY_PASSWORD" -d "_token=$T" http://localhost:$B/login
  curl -s -b $J -o /tmp/pg$B.html "http://localhost:$B/${URLPATH:-products.shopify}"
  wc -c /tmp/pg$B.html
done
