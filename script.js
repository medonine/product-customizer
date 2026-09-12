// =========================================================================
// Product Customizer — standalone app (runs inside the Wix iframe/HTML
// embed). Talks to the Wix Velo parent page via window.postMessage.
//
// Message contract (see README.md for full details):
//   Parent -> iframe: { type: 'INIT', payload: {...productConfig} }
//   Parent -> iframe: { type: 'ADD_TO_CART_SUCCESS' }
//   Parent -> iframe: { type: 'ADD_TO_CART_ERROR', payload: { message } }
//   iframe -> Parent: { type: 'CUSTOMIZER_READY' }
//   iframe -> Parent: { type: 'ADD_TO_CART', payload: { recipientName, title, size } }
// =========================================================================

const state = {
  config: null,
  currentSizeKey: null,
  designs: [], // { id, el, src }
};

const els = {
  previewStage: document.getElementById('previewStage'),
  productImage: document.getElementById('productImage'),
  previewText: document.getElementById('previewText'),
  previewTitleText: document.getElementById('previewTitleText'),
  productName: document.getElementById('productName'),
  productPrice: document.getElementById('productPrice'),
  recipientLabel: document.getElementById('recipientLabel'),
  titleLabel: document.getElementById('titleLabel'),
  recipientInput: document.getElementById('recipientInput'),
  titleInput: document.getElementById('titleInput'),
  sizeSelect: document.getElementById('sizeSelect'),
  designPalette: document.getElementById('designPalette'),
  designUpload: document.getElementById('designUpload'),
  addToCartButton: document.getElementById('addToCartButton'),
  statusMessage: document.getElementById('statusMessage'),
};

// A small built-in set of designs so this works with no external hosting.
// Swap these `src` values for your real logo/clip-art image URLs any time.
const PRESET_DESIGNS = [
  {
    id: 'star',
    label: 'Star',
    src:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,2 15,9 22,9 16.5,13.5 18.5,21 12,17 5.5,21 7.5,13.5 2,9 9,9" fill="#b8232f"/></svg>`
      ),
  },
  {
    id: 'ribbon',
    label: 'Ribbon',
    src:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="8" r="6" fill="#d4af37"/><polygon points="8,13 6,22 12,18 18,22 16,13" fill="#b8232f"/></svg>`
      ),
  },
  {
    id: 'laurel',
    label: 'Laurel',
    src:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 20c4-6 4-12 0-18" stroke="#2e7d32" stroke-width="2" fill="none"/><path d="M20 20c-4-6-4-12 0-18" stroke="#2e7d32" stroke-width="2" fill="none"/></svg>`
      ),
  },
];

// --- text fitting -------------------------------------------------------

function measureTextWidth(text, fontSize, fontFamily = 'Georgia, serif') {
  measureTextWidth._canvas = measureTextWidth._canvas || document.createElement('canvas');
  const ctx = measureTextWidth._canvas.getContext('2d');
  ctx.font = `${fontSize}px ${fontFamily}`;
  return ctx.measureText(text).width;
}

function fitText(el, text, maxWidth, baseFontSize) {
  el.textContent = text;
  let fontSize = baseFontSize;
  while (text && measureTextWidth(text, fontSize) > maxWidth && fontSize > 10) {
    fontSize -= 1;
  }
  el.style.fontSize = `${fontSize}px`;
}

// --- dragging -------------------------------------------------------------

// Makes any absolutely-positioned element draggable within `container`,
// using Pointer Events so mouse, touch, and pen all work the same way.
// Move/up listeners are attached to `document` (not the element itself)
// so dragging keeps working even if the browser won't grant pointer
// capture on a given element type (some browsers restrict this for
// <img> elements, even though it's fine on a <div>).
function makeDraggable(el, container) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      // Not supported for this element in this browser — that's fine,
      // the document-level listeners below still handle the drag.
    }

    el.classList.add('dragging');

    const startX = e.clientX;
    const startY = e.clientY;
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const origLeft = elRect.left - containerRect.left;
    const origTop = elRect.top - containerRect.top;

    function onMove(moveEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      const maxLeft = containerRect.width - elRect.width;
      const maxTop = containerRect.height - elRect.height;

      const newLeft = Math.max(0, Math.min(maxLeft, origLeft + dx));
      const newTop = Math.max(0, Math.min(maxTop, origTop + dy));

      el.style.left = `${newLeft}px`;
      el.style.top = `${newTop}px`;
    }

    function onUp(upEvent) {
      try {
        el.releasePointerCapture(upEvent.pointerId);
      } catch (err) {
        // ignore — see note above
      }
      el.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// Centers an element inside the stage the first time it gets content,
// anchored around a given vertical fraction (0 = top, 1 = bottom) so
// the recipient name and title land in sensible starting spots without
// needing a CSS transform (which would fight with left/top dragging).
function centerElement(el, container, verticalFraction) {
  const left = (container.clientWidth - el.offsetWidth) / 2;
  const top = container.clientHeight * verticalFraction - el.offsetHeight / 2;
  el.style.left = `${Math.max(0, left)}px`;
  el.style.top = `${Math.max(0, top)}px`;
}

// --- designs ----------------------------------------------------------

function addDesign(src) {
  const img = document.createElement('img');
  img.src = src;
  img.className = 'design-item draggable';
  img.draggable = false; // disable native browser drag-out so pointer drag works
  img.addEventListener('dragstart', (e) => e.preventDefault()); // belt-and-suspenders for Safari
  els.previewStage.appendChild(img);

  // Start it centered-ish; the customer drags it wherever they want
  img.style.left = `${els.previewStage.clientWidth / 2 - 30}px`;
  img.style.top = `${els.previewStage.clientHeight / 2 - 30}px`;

  img.addEventListener('dblclick', () => {
    img.remove();
    state.designs = state.designs.filter((d) => d.el !== img);
  });

  makeDraggable(img, els.previewStage);
  state.designs.push({ id: `${Date.now()}`, el: img, src });
}

function setupDesignPalette() {
  els.designPalette.innerHTML = '';
  PRESET_DESIGNS.forEach((design) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = design.label;
    btn.innerHTML = `<img src="${design.src}" alt="${design.label}" />`;
    btn.addEventListener('click', () => addDesign(design.src));
    els.designPalette.appendChild(btn);
  });
}

els.designUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => addDesign(reader.result);
  reader.readAsDataURL(file);
  e.target.value = ''; // allow uploading the same file again later
});

// --- config / rendering ---------------------------------------------------

function applyStyles() {
  const { previewFontSize = 24, previewFontColor = '#1a1a1a' } = state.config;
  els.previewText.style.color = previewFontColor;
  els.previewTitleText.style.color = previewFontColor;
  els.previewText.style.fontSize = `${previewFontSize}px`;
  els.previewTitleText.style.fontSize = `${Math.round(previewFontSize * 0.7)}px`;
}

function applySize(sizeKey) {
  const sizeConfig = (state.config.sizeScaleMap || {})[sizeKey];
  if (!sizeConfig) return;
  state.currentSizeKey = sizeKey;
  if (sizeConfig.image) els.productImage.src = sizeConfig.image;
  document.querySelector('.preview-stage').style.transform = sizeConfig.scale
    ? `scale(${sizeConfig.scale})`
    : 'scale(1)';
}

function setupSizeSelect() {
  const sizeKeys = Object.keys(state.config.sizeScaleMap || {});
  const sizeRow = els.sizeSelect.closest('div') || els.sizeSelect;
  const sizeLabel = document.querySelector('label[for="sizeSelect"]');

  if (sizeKeys.length === 0) {
    if (sizeLabel) sizeLabel.style.display = 'none';
    els.sizeSelect.style.display = 'none';
    return;
  }

  if (sizeLabel) sizeLabel.style.display = '';
  els.sizeSelect.style.display = '';
  els.sizeSelect.innerHTML = sizeKeys.map((k) => `<option value="${k}">${k}</option>`).join('');
  applySize(sizeKeys[0]);
  els.sizeSelect.value = sizeKeys[0];
  els.sizeSelect.onchange = () => applySize(els.sizeSelect.value);
}

function initFromConfig(payload) {
  state.config = payload;

  els.productImage.src = payload.productImage || '';
  els.productName.textContent = payload.productName || '';
  els.productPrice.textContent = payload.price ? `\u20b1${payload.price}` : '';

  els.recipientLabel.textContent = payload.recipientLabel || 'Recipient Name';
  els.titleLabel.textContent = payload.titleLabel || 'Title';
  els.recipientInput.maxLength = payload.maxNameLength || 40;
  els.titleInput.maxLength = payload.maxTitleLength || 40;

  els.previewText.textContent = '';
  els.previewTitleText.textContent = '';
  els.recipientInput.value = '';
  els.titleInput.value = '';
  els.statusMessage.textContent = '';
  els.addToCartButton.disabled = false;

  // Clear any designs left over from a previous product
  state.designs.forEach((d) => d.el.remove());
  state.designs = [];

  applyStyles();
  setupSizeSelect();
  setupDesignPalette();

  // Give the text elements a sensible starting position, then let the
  // customer drag them anywhere from there.
  centerElement(els.previewText, els.previewStage, 0.55);
  centerElement(els.previewTitleText, els.previewStage, 0.68);
  makeDraggable(els.previewText, els.previewStage);
  makeDraggable(els.previewTitleText, els.previewStage);
}

// --- input handlers ---------------------------------------------------

els.recipientInput.addEventListener('input', () => {
  if (!state.config) return;
  const maxWidth = state.config.previewMaxWidth || 200;
  const baseFontSize = state.config.previewFontSize || 24;
  fitText(els.previewText, els.recipientInput.value, maxWidth, baseFontSize);
});

els.titleInput.addEventListener('input', () => {
  if (!state.config) return;
  const maxWidth = state.config.previewMaxWidth || 200;
  const baseFontSize = (state.config.previewFontSize || 24) * 0.7;
  fitText(els.previewTitleText, els.titleInput.value, maxWidth, baseFontSize);
});

els.addToCartButton.addEventListener('click', () => {
  if (!state.config) return;
  const recipientName = els.recipientInput.value.trim();
  const title = els.titleInput.value.trim();

  if (state.config.requireRecipientName && !recipientName) {
    els.statusMessage.textContent = 'Please enter a recipient name.';
    return;
  }

  els.addToCartButton.disabled = true;
  els.statusMessage.textContent = 'Adding to cart\u2026';

  // Capture final placement so production/fulfillment knows exactly
  // where the text and any designs ended up on the plaque.
  const stageRect = els.previewStage.getBoundingClientRect();
  const relativePosition = (el) => {
    const r = el.getBoundingClientRect();
    return {
      xPct: ((r.left - stageRect.left) / stageRect.width) * 100,
      yPct: ((r.top - stageRect.top) / stageRect.height) * 100,
    };
  };

  window.parent.postMessage(
    {
      type: 'ADD_TO_CART',
      payload: {
        recipientName,
        title,
        size: state.currentSizeKey,
        recipientPosition: relativePosition(els.previewText),
        titlePosition: relativePosition(els.previewTitleText),
        designs: state.designs.map((d) => ({
          src: d.src,
          ...relativePosition(d.el),
        })),
      },
    },
    '*' // TODO: replace '*' with your actual Wix site origin before going live
  );
});

// --- messages from the parent (Wix Velo page) ---------------------------

window.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'INIT') {
    initFromConfig(payload);
  }

  if (type === 'ADD_TO_CART_SUCCESS') {
    els.addToCartButton.disabled = false;
    els.statusMessage.textContent = 'Added to cart!';
  }

  if (type === 'ADD_TO_CART_ERROR') {
    els.addToCartButton.disabled = false;
    els.statusMessage.textContent = `Something went wrong: ${(payload && payload.message) || 'please try again'}`;
  }
});

// Tell the parent we're loaded and ready to receive product config
window.parent.postMessage({ type: 'CUSTOMIZER_READY' }, '*');