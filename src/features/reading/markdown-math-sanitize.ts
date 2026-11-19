import type { DOMPurify } from 'dompurify';

export const mathSourceAttribute = 'data-reading-math-source';
export const mathSelector = 'span[' + mathSourceAttribute + ']';
export const mathDisplayClass = 'reading-math-display';

const mathML = 'math semantics annotation mrow mi mn mo mtext mspace mfrac msqrt mroot msub msup msubsup mover munder munderover mmultiscripts mprescripts'
  + ' none mtable mtr mtd mstyle mpadded mphantom menclose mglyph';
const mathMLTags = new Set(mathML.split(' '));
const svgTags = new Set(['svg', 'path', 'line']);
const mathMLAttrs = 'xmlns display encoding mathvariant mathsize stretchy symmetric fence separator lspace rspace'
  + ' accent accentunder linethickness width height depth voffset rowspacing columnspacing rowlines columnlines columnalign rowalign'
  + ' columnspan rowspan columnwidth displaystyle scriptlevel notation minsize maxsize form movablelimits largeop';
const mathLayoutAttributes = new Set(mathMLAttrs.split(' '));
const svgAttrs = new Set('xmlns width height viewbox preserveaspectratio d x1 y1 x2 y2 stroke-width'.split(' '));
const spanAttrs = new Set(['style', 'aria-hidden', mathSourceAttribute]);
const mathAttributes = [...new Set([...mathLayoutAttributes, ...svgAttrs, ...spanAttrs])];

const lengthProperties = new Set(('height width min-width top bottom left vertical-align margin margin-top margin-right margin-left padding-left '
  + 'border-top-width border-bottom-width border-right-width border-width text-shadow').split(' '));
const lengthAttributes = new Set(('width height depth voffset mathsize lspace rspace linethickness rowspacing columnspacing columnwidth minsize maxsize '
  + 'x1 y1 x2 y2 stroke-width').split(' '));
const length = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(em|px|%)?$/;
function boundedLengths(value: string) {
  return value.trim().split(/\s+/).every(part => {
    const match = length.exec(part);
    if (!match) return false;
    const magnitude = Math.abs(Number(match[1]));
    return match[2] === '%' ? magnitude <= 100 : match[2] ? magnitude <= 10 : magnitude === 0;
  });
}

export function safeMathLength(tag: string, name: string, value: string) {
  // Radicals and stretchy accents use a fixed 400em drawing that KaTeX crops inside its layout box.
  return !lengthAttributes.has(name) || tag === 'svg' && name === 'width' && value === '400em' || boundedLengths(value);
}

export const safeStyle = (style: string) => style.split(';').every(declaration => {
  if (!declaration.trim()) return true;
  const [property, value, extra] = declaration.split(':');
  const name = property.trim();
  if (extra !== undefined || !value) return false;
  if (name === 'position') return /^(?:absolute|relative)$/.test(value.trim());
  if (name === 'border-style' || name === 'border-right-style') return /^(?:solid|dashed)$/.test(value.trim());
  return lengthProperties.has(name) && boundedLengths(value);
});

export function allowReadingMath(purifier: DOMPurify) {
  purifier.addHook('uponSanitizeElement', (node, { tagName, allowedTags }) => {
    if (tagName === 'span' || mathMLTags.has(tagName) || svgTags.has(tagName)) {
      allowedTags[tagName] = (node as Element).closest(mathSelector) !== null
        || tagName === 'span' && !!(node as Element).classList?.contains(mathDisplayClass);
    }
  });
  purifier.addHook('uponSanitizeAttribute', (node, event) => {
    const { attrName, attrValue } = event;
    if (!mathAttributes.includes(attrName)) return;
    const tag = node.localName;
    const permitted = tag === 'span' ? spanAttrs : mathMLTags.has(tag) ? mathLayoutAttributes : svgTags.has(tag) ? svgAttrs : null;
    event.keepAttr = !!node.closest(mathSelector) && !!permitted?.has(attrName)
      && (attrName !== 'style' || safeStyle(attrValue)) && safeMathLength(tag, attrName, attrValue);
  });
}

export const readingMathAttributes = mathAttributes;
