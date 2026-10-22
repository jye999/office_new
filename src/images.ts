// Sharp-based equivalents of the Intervention 2.3 calls the app uses:
// Image::make($src)->widen($w, fn($c) => $c->upsize())->stream()
// and ->resize(300, null, fn($c) => $c->upsize())->stream() (ItemController).
// `upsize()` = withoutEnlargement (never scale a smaller image up). Output
// keeps the input format, same as Intervention's stream().

import sharp from 'sharp';

export interface ImageConstraint {
  // Intervention's upsize(): do not enlarge.
  upsize(): void;
}

export interface InterventionImage {
  widen(width: number, constraint?: (c: ImageConstraint) => void): InterventionImage;
  resize(width: number, height: number | null, constraint?: (c: ImageConstraint) => void): InterventionImage;
  // ->stream() returns the encoded image bytes.
  stream(): Promise<Buffer>;
}

export function image(src: Buffer | string): InterventionImage {
  let width: number | undefined;
  let height: number | undefined;
  let upsize = false;

  const applyConstraint = (constraint?: (c: ImageConstraint) => void) => {
    if (!constraint) return;
    let set = false;
    constraint({ upsize: () => (set ? undefined : (upsize = (set = true))) });
  };

  return {
    widen(w, constraint) {
      width = w;
      height = undefined;
      applyConstraint(constraint);
      return this;
    },
    resize(w, h, constraint) {
      width = w;
      height = h ?? undefined;
      applyConstraint(constraint);
      return this;
    },
    async stream() {
      return sharp(src).resize({ width, height, fit: 'inside', withoutEnlargement: upsize }).toBuffer();
    },
  };
}
