// PHP 7.x usort()/sort(): zend_sort (Zend/zend_sort.c) — hybrid insertion sort (n <= 16) and quicksort.
// Unlike Array.prototype.sort it is NOT stable, and the old app runs php:7.4, so ties come out in
// zend_sort's order. PHP >= 8.0 is stable; drop this if the target PHP is ever upgraded.

type Cmp<T> = (a: T, b: T) => number;

export function phpUsort<T>(arr: T[], cmp: Cmp<T>): T[] {
  zendSort(arr, 0, arr.length, cmp);
  return arr;
}

function swp<T>(a: T[], i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

function sort3<T>(a: T[], x: number, y: number, z: number, cmp: Cmp<T>): void {
  if (!(cmp(a[x], a[y]) > 0)) {
    if (!(cmp(a[y], a[z]) > 0)) return;
    swp(a, y, z);
    if (cmp(a[x], a[y]) > 0) swp(a, x, y);
    return;
  }
  if (!(cmp(a[z], a[y]) > 0)) {
    swp(a, x, z);
    return;
  }
  swp(a, x, y);
  if (cmp(a[y], a[z]) > 0) swp(a, y, z);
}

function sort4<T>(a: T[], w: number, x: number, y: number, z: number, cmp: Cmp<T>): void {
  sort3(a, w, x, y, cmp);
  if (cmp(a[y], a[z]) > 0) {
    swp(a, y, z);
    if (cmp(a[x], a[y]) > 0) {
      swp(a, x, y);
      if (cmp(a[w], a[x]) > 0) swp(a, w, x);
    }
  }
}

function sort5<T>(a: T[], v: number, w: number, x: number, y: number, z: number, cmp: Cmp<T>): void {
  sort4(a, v, w, x, y, cmp);
  if (cmp(a[y], a[z]) > 0) {
    swp(a, y, z);
    if (cmp(a[x], a[y]) > 0) {
      swp(a, x, y);
      if (cmp(a[w], a[x]) > 0) {
        swp(a, w, x);
        if (cmp(a[v], a[w]) > 0) swp(a, v, w);
      }
    }
  }
}

function insertSort<T>(a: T[], start: number, n: number, cmp: Cmp<T>): void {
  switch (n) {
    case 0:
    case 1:
      return;
    case 2:
      if (cmp(a[start], a[start + 1]) > 0) swp(a, start, start + 1);
      return;
    case 3:
      sort3(a, start, start + 1, start + 2, cmp);
      return;
    case 4:
      sort4(a, start, start + 1, start + 2, start + 3, cmp);
      return;
    case 5:
      sort5(a, start, start + 1, start + 2, start + 3, start + 4, cmp);
      return;
  }
  const end = start + n;
  const sentry = start + 6;
  let i: number;
  let j: number;
  let k: number;
  for (i = start + 1; i < sentry; i++) {
    j = i - 1;
    if (!(cmp(a[j], a[i]) > 0)) continue;
    while (j !== start) {
      j--;
      if (!(cmp(a[j], a[i]) > 0)) {
        j++;
        break;
      }
    }
    for (k = i; k > j; k--) swp(a, k, k - 1);
  }
  for (i = sentry; i < end; i++) {
    j = i - 1;
    if (!(cmp(a[j], a[i]) > 0)) continue;
    do {
      j -= 2;
      if (!(cmp(a[j], a[i]) > 0)) {
        j++;
        if (!(cmp(a[j], a[i]) > 0)) j++;
        break;
      }
      if (j === start) break;
      if (j === start + 1) {
        j--;
        if (cmp(a[i], a[j]) > 0) j++;
        break;
      }
    } while (true);
    for (k = i; k > j; k--) swp(a, k, k - 1);
  }
}

function zendSort<T>(a: T[], base: number, nmemb: number, cmp: Cmp<T>): void {
  while (true) {
    if (nmemb <= 16) {
      insertSort(a, base, nmemb, cmp);
      return;
    }
    const start = base;
    const end = start + nmemb;
    const offset = nmemb >> 1;
    let pivot = start + offset;
    if (nmemb >> 10) {
      const delta = offset >> 1;
      sort5(a, start, start + delta, pivot, pivot + delta, end - 1, cmp);
    } else {
      sort3(a, start, pivot, end - 1, cmp);
    }
    swp(a, start + 1, pivot);
    pivot = start + 1;
    let i = pivot + 1;
    let j = end - 1;
    done: while (true) {
      while (cmp(a[pivot], a[i]) > 0) {
        i++;
        if (i === j) break done;
      }
      j--;
      if (j === i) break done;
      while (cmp(a[j], a[pivot]) > 0) {
        j--;
        if (j === i) break done;
      }
      swp(a, i, j);
      i++;
      if (i === j) break done;
    }
    swp(a, pivot, i - 1);
    if (i - 1 - start < end - i) {
      zendSort(a, start, i - start - 1, cmp);
      base = i;
      nmemb = end - i;
    } else {
      zendSort(a, i, end - i, cmp);
      nmemb = i - start - 1;
    }
  }
}
