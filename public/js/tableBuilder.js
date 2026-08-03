import { FIELD_GROUPS, MERGE_TEMPLATES, getAllFields } from './fieldMappings.js';

let selectedColumns = [{ id: 'index', type: 'number', label: 'م', path: 'index', isIndex: true }];
let onColumnsChangedCallback = null;

export function initTableBuilder(container, onColumnsChanged) {
  onColumnsChangedCallback = onColumnsChanged;
  
  container.innerHTML = `
    <div class="table-builder-layout">
      <div class="card available-fields-panel">
        <h3>الحقول المتاحة</h3>
        <div class="fields-accordion" id="fields-accordion"></div>
      </div>
      <div class="card selected-columns-panel">
        <div class="panel-header">
          <h3>الأعمدة المختارة</h3>
          <button class="btn btn-secondary" id="btn-merge-columns">
            <span class="icon">🔗</span> دمج أعمدة
          </button>
        </div>
        <div class="columns-list" id="selected-columns-list"></div>
      </div>
    </div>
  `;

  renderAvailableFields();
  renderSelectedColumns();
  setupDragAndDrop();
  
  document.getElementById('btn-merge-columns').addEventListener('click', openMergeModal);
}

function renderAvailableFields() {
  const accordion = document.getElementById('fields-accordion');
  accordion.innerHTML = '';

  for (const [groupKey, group] of Object.entries(FIELD_GROUPS)) {
    const groupEl = document.createElement('div');
    groupEl.className = 'field-group';
    
    const headerEl = document.createElement('div');
    headerEl.className = 'field-group-header';
    headerEl.innerHTML = `
      <span class="icon">${group.icon}</span>
      <span class="label">${group.label}</span>
      <span class="toggle">▼</span>
    `;
    
    const contentEl = document.createElement('div');
    contentEl.className = 'field-group-content';
    
    for (const [path, info] of Object.entries(group.fields)) {
      const fieldEl = document.createElement('div');
      fieldEl.className = 'field-item';
      fieldEl.innerHTML = `
        <span class="field-label">${info.label}</span>
        <span class="field-type badge badge-${info.type}">${getTypeLabel(info.type)}</span>
        <button class="btn-icon btn-add-field" data-path="${path}" title="إضافة">+</button>
      `;
      contentEl.appendChild(fieldEl);
    }
    
    headerEl.addEventListener('click', () => {
      groupEl.classList.toggle('active');
    });
    
    groupEl.appendChild(headerEl);
    groupEl.appendChild(contentEl);
    accordion.appendChild(groupEl);
  }

  // Add click events for Add buttons
  accordion.querySelectorAll('.btn-add-field').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = btn.dataset.path;
      addFieldAsColumn(path);
    });
  });
}

function getTypeLabel(type) {
  const labels = {
    'text': 'نص',
    'number': 'رقم',
    'date': 'تاريخ',
    'enum': 'قائمة',
    'merged': 'مدمج'
  };
  return labels[type] || type;
}

function addFieldAsColumn(path) {
  // Check if already exists
  if (selectedColumns.some(col => col.path === path && !col.isMerged)) {
    window.app.showToast('الحقل موجود بالفعل', 'warning');
    return;
  }

  // Find field info
  let info = null;
  for (const group of Object.values(FIELD_GROUPS)) {
    if (group.fields[path]) {
      info = group.fields[path];
      break;
    }
  }

  if (info) {
    selectedColumns.push({
      id: 'col_' + Date.now(),
      path: path,
      label: info.label,
      type: info.type,
      isMerged: false
    });
    
    updateColumns();
    window.app.showToast(`تم إضافة ${info.label}`, 'success');
  }
}

function renderSelectedColumns() {
  const list = document.getElementById('selected-columns-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  if (selectedColumns.length === 0) {
    list.innerHTML = `<div class="empty-state">لم يتم اختيار أي أعمدة</div>`;
    return;
  }

  selectedColumns.forEach((col, index) => {
    const item = document.createElement('div');
    item.className = 'column-item';
    item.draggable = !col.isIndex;
    item.dataset.index = index;
    
    const dragHandle = col.isIndex ? '<span class="icon locked">🔒</span>' : '<span class="icon drag-handle">⋮⋮</span>';
    const removeBtn = col.isIndex ? '' : `<button class="btn-icon btn-remove-col" data-index="${index}" title="حذف">✕</button>`;
    
    let partsHtml = '';
    if (col.isMerged) {
      let displaySep = col.separator;
      if (col.separator === 'newline') displaySep = '↵';
      if (col.separator === 'space') displaySep = '␣';
      if (col.separator === 'dash') displaySep = '-';
      if (col.separator === 'none') displaySep = 'بدون';
      
      partsHtml = `<div class="merged-parts">` + col.parts.map(p => {
        let l = p.path;
        for(let g of Object.values(FIELD_GROUPS)) { if(g.fields[p.path]) l = g.fields[p.path].label; }
        return `<span class="badge">${l}</span>`;
      }).join(` <span class="separator">${displaySep}</span> `) + `</div>`;
    }

    item.innerHTML = `
      ${dragHandle}
      <div class="column-info">
        <div class="column-title">
          <input type="text" class="column-label-input" value="${col.label}" data-index="${index}" ${col.isIndex ? 'readonly' : ''}>
          <span class="badge badge-${col.type}">${getTypeLabel(col.type)}</span>
        </div>
        ${partsHtml}
      </div>
      ${removeBtn}
    `;
    
    list.appendChild(item);
  });

  // Bind remove events
  list.querySelectorAll('.btn-remove-col').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(btn.dataset.index);
      selectedColumns.splice(idx, 1);
      updateColumns();
    });
  });

  // Bind label change events
  list.querySelectorAll('.column-label-input:not([readonly])').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index);
      selectedColumns[idx].label = e.target.value;
      notifyChanges();
    });
  });
}

let draggedItem = null;

function setupDragAndDrop() {
  const list = document.getElementById('selected-columns-list');
  
  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.column-item');
    if (!item || item.draggable === false) {
      e.preventDefault();
      return;
    }
    draggedItem = item;
    setTimeout(() => item.classList.add('dragging'), 0);
  });

  list.addEventListener('dragend', e => {
    if (!draggedItem) return;
    draggedItem.classList.remove('dragging');
    draggedItem = null;
    
    // Rebuild array based on DOM order
    const items = Array.from(list.querySelectorAll('.column-item'));
    const newOrder = items.map(el => {
      const oldIndex = parseInt(el.dataset.index);
      return selectedColumns[oldIndex];
    });
    
    selectedColumns = newOrder;
    updateColumns();
  });

  list.addEventListener('dragover', e => {
    e.preventDefault();
    if (!draggedItem) return;
    
    const afterElement = getDragAfterElement(list, e.clientY);
    
    // Prevent dragging before the index column
    if (afterElement && afterElement.dataset.index === "0") {
        return;
    }

    if (afterElement == null) {
      list.appendChild(draggedItem);
    } else {
      list.insertBefore(draggedItem, afterElement);
    }
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.column-item:not(.dragging):not([draggable="false"])')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function updateColumns() {
  renderSelectedColumns();
  notifyChanges();
}

function notifyChanges() {
  if (onColumnsChangedCallback) {
    onColumnsChangedCallback(selectedColumns);
  }
}

export function getSelectedColumns() {
  return selectedColumns;
}

export function loadColumns(columns) {
  selectedColumns = columns;
  updateColumns();
}

// --- Merge Columns Modal ---
function openMergeModal() {
  const modalContent = `
    <div class="modal-header">
      <h2>دمج أعمدة</h2>
      <button class="btn-icon close-modal">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group mb-4" style="background: rgba(0,0,0,0.1); padding: 1rem; border-radius: var(--radius-md);">
        <label style="font-weight: bold; margin-bottom: 0.5rem; display: block;">شكل الفاصل بين القيم المدمجة (للقوالب والدمج المخصص)</label>
        <div class="direction-toggle">
          <label class="radio-container">
            <input type="radio" name="modalMergeSep" value="newline" checked>
            <span class="radio-mark"></span>
            سطر جديد ↵
          </label>
          <label class="radio-container">
            <input type="radio" name="modalMergeSep" value="space">
            <span class="radio-mark"></span>
            مسافة ␣
          </label>
          <label class="radio-container">
            <input type="radio" name="modalMergeSep" value="dash">
            <span class="radio-mark"></span>
            شرطة -
          </label>
          <label class="radio-container">
            <input type="radio" name="modalMergeSep" value="custom">
            <span class="radio-mark"></span>
            مخصص (من الأسفل)
          </label>
        </div>
      </div>

      <div class="templates-section">
        <h3>قوالب جاهزة</h3>
        <div class="templates-list">
          ${MERGE_TEMPLATES.map((t, i) => `
            <button class="btn btn-outline template-btn" data-index="${i}">
              ${t.label}
            </button>
          `).join('')}
        </div>
      </div>
      
      <div class="custom-merge-section">
        <h3>دمج مخصص</h3>
        <div class="form-group">
          <label>اسم العمود المدمج</label>
          <input type="text" id="merge-label" class="form-control" placeholder="مثال: الاسم والمؤهل">
        </div>
        <div class="form-group">
          <label>الفاصل المخصص (اختياري)</label>
          <input type="text" id="merge-separator" class="form-control" placeholder="يستخدم إذا تم اختيار 'مخصص' أعلاه">
        </div>
        <div class="form-group">
          <label>اختر الحقول للدمج</label>
          <div class="fields-to-merge-list">
            ${getAllFields().map(f => `
              <label class="checkbox-container">
                <input type="checkbox" class="merge-field-checkbox" value="${f.path}" data-label="${f.label}">
                <span class="checkmark"></span>
                ${f.label} <small>(${f.group})</small>
              </label>
            `).join('')}
          </div>
        </div>
        <button class="btn btn-primary w-100" id="btn-create-custom-merge">إنشاء عمود مدمج</button>
      </div>
    </div>
  `;
  
  window.app.showModal(modalContent);
  
  // Bind template buttons
  document.querySelectorAll('.template-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const t = MERGE_TEMPLATES[parseInt(e.target.dataset.index)];
      let sep = document.querySelector('input[name="modalMergeSep"]:checked').value;
      if (sep === 'custom') sep = document.getElementById('merge-separator').value;
      addMergedColumn(t.label, sep, t.fields);
      window.app.closeModal();
    });
  });
  
  // Bind custom merge
  document.getElementById('btn-create-custom-merge').addEventListener('click', () => {
    const label = document.getElementById('merge-label').value.trim();
    let sep = document.querySelector('input[name="modalMergeSep"]:checked').value;
    if (sep === 'custom') sep = document.getElementById('merge-separator').value;
    
    if (!label) {
      window.app.showToast('يرجى إدخال اسم للعمود', 'error');
      return;
    }
    if (selectedCheckboxes.length < 2) {
      window.app.showToast('يرجى اختيار حقلين على الأقل للدمج', 'error');
      return;
    }
    
    const paths = Array.from(selectedCheckboxes).map(cb => cb.value);
    addMergedColumn(label, sep, paths);
    window.app.closeModal();
  });
}

function addMergedColumn(label, separator, fieldPaths) {
  selectedColumns.push({
    id: 'merged_' + Date.now(),
    label: label,
    type: 'merged',
    isMerged: true,
    separator: separator,
    parts: fieldPaths.map(path => ({ path }))
  });
  
  updateColumns();
  window.app.showToast(`تم إضافة عمود ${label}`, 'success');
}
