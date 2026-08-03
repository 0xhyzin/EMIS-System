import { getReferenceValues, updateReferenceOrder, getAllReferenceFields } from './api.js';
import { FIELD_GROUPS, getFieldInfo, getAllFields } from './fieldMappings.js';

let sortingConfig = [];
let filterConfig = [];
let filterValuesCache = {}; // Cache reference values per field
let onSortingChangedCallback = null;
let onFilterChangedCallback = null;

export function initSorting(container, onSortingChanged, onFilterChanged) {
  onSortingChangedCallback = onSortingChanged;
  onFilterChangedCallback = onFilterChanged;
  
  container.innerHTML = `
    <!-- Filters Section -->
    <div class="card filter-panel mb-4">
      <div class="panel-header">
        <h3>🔍 الفلاتر</h3>
        <button class="btn btn-secondary" id="btn-add-filter">
          <span class="icon">➕</span> إضافة فلتر
        </button>
      </div>
      <p class="text-muted mb-3 px-3">استبعد أو اعرض فقط قيم محددة من البيانات.</p>
      <div class="filter-levels-list" id="filter-levels-list"></div>
    </div>

    <!-- Sorting Section -->
    <div class="card sorting-controls-panel">
      <div class="panel-header">
        <h3>🔀 مستويات الترتيب</h3>
        <button class="btn btn-secondary" id="btn-add-sort-level">
          <span class="icon">➕</span> إضافة مستوى
        </button>
      </div>
      <p class="text-muted mb-3 px-3">حدد حقل واحد لكل مستوى ترتيب. المستوى الأول له الأولوية الأعلى.</p>
      <div class="sort-levels-list" id="sort-levels-list"></div>
    </div>
  `;

  document.getElementById('btn-add-sort-level').addEventListener('click', addSortLevel);
  document.getElementById('btn-add-filter').addEventListener('click', addFilter);
  renderSortLevels();
  renderFilters();
}

// =========================================
// SORTING
// =========================================

function getAllSortableFields() {
  const result = [];
  for (const [groupKey, group] of Object.entries(FIELD_GROUPS)) {
    for (const [path, info] of Object.entries(group.fields)) {
      result.push({ path, label: info.label, type: info.type, group: group.label, icon: group.icon });
    }
  }
  return result;
}

function addSortLevel() {
  const allFields = getAllSortableFields();
  const unusedField = allFields.find(f => !sortingConfig.some(s => s.path === f.path));
  
  if (!unusedField) {
    window.app.showToast('تم استخدام جميع الحقول المتاحة', 'warning');
    return;
  }

  sortingConfig.push({
    id: 'sort_' + Date.now(),
    path: unusedField.path,
    label: unusedField.label,
    type: unusedField.type,
    direction: 'asc'
  });
  
  renderSortLevels();
  notifySortChanges();
}

function renderSortLevels() {
  const list = document.getElementById('sort-levels-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  if (sortingConfig.length === 0) {
    list.innerHTML = `<div class="empty-state">لم يتم تحديد مستويات ترتيب. سيتم عرض البيانات بالترتيب الافتراضي.</div>`;
    return;
  }

  const allFields = getAllSortableFields();

  sortingConfig.forEach((sort, index) => {
    const item = document.createElement('div');
    item.className = 'sort-level-item card';
    item.draggable = true;
    item.dataset.index = index;
    
    let fieldOptionsHtml = '';
    const groups = {};
    allFields.forEach(f => {
      if (!groups[f.group]) groups[f.group] = [];
      const isUsed = sortingConfig.some(s => s.path === f.path) && sort.path !== f.path;
      groups[f.group].push({ ...f, isUsed });
    });
    
    for (const [groupName, fields] of Object.entries(groups)) {
      fieldOptionsHtml += `<optgroup label="${groupName}">`;
      fields.forEach(f => {
        const selected = f.path === sort.path ? 'selected' : '';
        const disabled = f.isUsed ? 'disabled' : '';
        fieldOptionsHtml += `<option value="${f.path}" ${selected} ${disabled}>${f.label}</option>`;
      });
      fieldOptionsHtml += `</optgroup>`;
    }

    let dirHtml = '';
    if (sort.type === 'enum') {
      dirHtml = `
        <div class="sort-direction-btns">
          <button class="btn btn-sm ${sort.direction === 'asc' ? 'btn-primary' : 'btn-outline'} dir-btn" data-index="${index}" data-dir="asc">أ ← ي</button>
          <button class="btn btn-sm ${sort.direction === 'desc' ? 'btn-primary' : 'btn-outline'} dir-btn" data-index="${index}" data-dir="desc">ي ← أ</button>
          <button class="btn btn-sm ${sort.direction === 'custom' ? 'btn-accent' : 'btn-outline'} btn-custom-sort" data-index="${index}" data-path="${sort.path}">ترتيب مخصص</button>
        </div>
      `;
    } else if (sort.type === 'date') {
      dirHtml = `
        <div class="sort-direction-btns">
          <button class="btn btn-sm ${sort.direction === 'asc' ? 'btn-primary' : 'btn-outline'} dir-btn" data-index="${index}" data-dir="asc">الأقدم أولاً</button>
          <button class="btn btn-sm ${sort.direction === 'desc' ? 'btn-primary' : 'btn-outline'} dir-btn" data-index="${index}" data-dir="desc">الأحدث أولاً</button>
        </div>
      `;
    } else {
      dirHtml = `
        <div class="sort-direction-btns">
          <button class="btn btn-sm ${sort.direction === 'asc' ? 'btn-primary' : 'btn-outline'} dir-btn" data-index="${index}" data-dir="asc">أ ← ي</button>
          <button class="btn btn-sm ${sort.direction === 'desc' ? 'btn-primary' : 'btn-outline'} dir-btn" data-index="${index}" data-dir="desc">ي ← أ</button>
        </div>
      `;
    }

    item.innerHTML = `
      <div class="sort-header">
        <span class="drag-handle icon">⋮⋮</span>
        <span class="sort-badge">مستوى ${index + 1}</span>
        <button class="btn-icon btn-remove-sort" data-index="${index}" title="حذف">✕</button>
      </div>
      <div class="sort-body">
        <select class="form-control field-select" data-index="${index}">
          ${fieldOptionsHtml}
        </select>
        ${dirHtml}
      </div>
    `;
    
    list.appendChild(item);
  });

  bindSortEvents(list);
  setupSortDragAndDrop();
}

function bindSortEvents(list) {
  list.querySelectorAll('.btn-remove-sort').forEach(btn => {
    btn.addEventListener('click', () => {
      sortingConfig.splice(parseInt(btn.dataset.index), 1);
      renderSortLevels();
      notifySortChanges();
    });
  });

  list.querySelectorAll('.field-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index);
      const newPath = e.target.value;
      const fieldInfo = getFieldInfo(newPath);
      sortingConfig[idx].path = newPath;
      sortingConfig[idx].label = fieldInfo.label;
      sortingConfig[idx].type = fieldInfo.type;
      sortingConfig[idx].direction = 'asc';
      renderSortLevels();
      notifySortChanges();
    });
  });

  list.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sortingConfig[parseInt(btn.dataset.index)].direction = btn.dataset.dir;
      renderSortLevels();
      notifySortChanges();
    });
  });

  list.querySelectorAll('.btn-custom-sort').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      sortingConfig[idx].direction = 'custom';
      await openCustomSortModal(btn.dataset.path, idx);
    });
  });
}

let draggedSortItem = null;

function setupSortDragAndDrop() {
  const list = document.getElementById('sort-levels-list');
  if (!list) return;
  
  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.sort-level-item');
    if (!item) return;
    draggedSortItem = item;
    setTimeout(() => item.classList.add('dragging'), 0);
  });

  list.addEventListener('dragend', () => {
    if (!draggedSortItem) return;
    draggedSortItem.classList.remove('dragging');
    draggedSortItem = null;
    
    const items = Array.from(list.querySelectorAll('.sort-level-item'));
    sortingConfig = items.map(el => sortingConfig[parseInt(el.dataset.index)]);
    renderSortLevels();
    notifySortChanges();
  });

  list.addEventListener('dragover', e => {
    e.preventDefault();
    if (!draggedSortItem) return;
    const after = getDragAfterElement(list, e.clientY, '.sort-level-item');
    if (!after) list.appendChild(draggedSortItem);
    else list.insertBefore(draggedSortItem, after);
  });
}

function getDragAfterElement(container, y, selector) {
  return [...container.querySelectorAll(`${selector}:not(.dragging)`)].reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// =========================================
// FILTERS - Inline values
// =========================================

function getFilterableFields() {
  const result = [];
  for (const [groupKey, group] of Object.entries(FIELD_GROUPS)) {
    for (const [path, info] of Object.entries(group.fields)) {
      if (info.type === 'enum') {
        result.push({ path, label: info.label, type: info.type, group: group.label });
      }
    }
  }
  return result;
}

async function addFilter() {
  const allFilterable = getFilterableFields();
  
  if (allFilterable.length === 0) {
    window.app.showToast('لا توجد حقول يمكن تصفيتها', 'warning');
    return;
  }

  const unusedField = allFilterable.find(f => !filterConfig.some(fl => fl.path === f.path));
  
  if (!unusedField) {
    window.app.showToast('تم استخدام جميع الحقول المتاحة للفلترة', 'warning');
    return;
  }

  // Fetch values for this field immediately
  let values = [];
  try {
    values = await fetchFilterValues(unusedField.path);
  } catch (e) {
    console.error('Failed to fetch filter values:', e);
  }

  filterConfig.push({
    id: 'filter_' + Date.now(),
    path: unusedField.path,
    label: unusedField.label,
    mode: 'exclude',
    selectedValues: [], // values the user checked
    availableValues: values // all available values for this field
  });
  
  renderFilters();
}

async function fetchFilterValues(path) {
  if (filterValuesCache[path] && filterValuesCache[path].length > 0) return filterValuesCache[path];
  
  try {
    // Primary: get from employees directly - most reliable
    const { getEmployees } = await import('./api.js');
    const employees = await getEmployees();
    
    const unique = new Set();
    const parts = path.split('.');
    
    employees.forEach(emp => {
      // Employees from API come as { emp_code, full_name, national_id, raw_data }
      // raw_data is already parsed as object
      const data = emp.raw_data || emp;
      let val = data;
      for (const part of parts) {
        if (val === null || val === undefined) { val = ''; break; }
        if (Array.isArray(val) && val.length > 0) val = val[0];
        val = val[part];
      }
      const str = String(val || '').trim();
      if (str && str !== 'null' && str !== 'undefined') unique.add(str);
    });
    
    let values = [...unique].sort((a, b) => a.localeCompare(b, 'ar'));
    
    // Fallback to DB reference if employees gave nothing
    if (values.length === 0) {
      const refValues = await getReferenceValues(path);
      if (Array.isArray(refValues) && refValues.length > 0) {
        values = refValues.map(v => v.field_value || '').filter(Boolean);
      }
    }
    
    filterValuesCache[path] = values;
    return values;
  } catch (e) {
    console.error('fetchFilterValues error:', e);
    return [];
  }
}


function renderFilters() {
  const list = document.getElementById('filter-levels-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  if (filterConfig.length === 0) {
    list.innerHTML = `<div class="empty-state">لم يتم إضافة فلاتر. سيتم عرض جميع البيانات.</div>`;
    return;
  }

  const allFilterable = getFilterableFields();

  filterConfig.forEach((filter, index) => {
    const item = document.createElement('div');
    item.className = 'filter-level-item card';
    item.dataset.index = index;

    // Build field options
    let fieldOptionsHtml = '';
    allFilterable.forEach(f => {
      const isUsed = filterConfig.some(fl => fl.path === f.path) && filter.path !== f.path;
      const selected = f.path === filter.path ? 'selected' : '';
      const disabled = isUsed ? 'disabled' : '';
      fieldOptionsHtml += `<option value="${f.path}" ${selected} ${disabled}>${f.label}</option>`;
    });

    // Build inline values checkboxes
    const availableValues = filter.availableValues || [];
    let valuesHtml = '';
    if (availableValues.length > 0) {
      valuesHtml = `
        <div class="filter-inline-values">
          <div class="filter-values-header">
            <span class="text-muted small">${filter.mode === 'exclude' ? 'حدد القيم التي تريد استبعادها:' : 'حدد القيم التي تريد عرضها فقط:'}</span>
            <div class="d-flex gap-1">
              <button class="btn btn-xs btn-outline btn-select-all-inline" data-index="${index}">تحديد الكل</button>
              <button class="btn btn-xs btn-outline btn-deselect-all-inline" data-index="${index}">إلغاء الكل</button>
            </div>
          </div>
          <div class="filter-values-grid">
            ${availableValues.map(val => {
              const isChecked = filter.selectedValues.includes(val) ? 'checked' : '';
              return `
                <label class="filter-chip ${isChecked ? 'active' : ''}">
                  <input type="checkbox" class="filter-val-check" data-filter-index="${index}" value="${val}" ${isChecked}>
                  <span class="filter-chip-text">${val}</span>
                </label>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      valuesHtml = `<div class="text-muted small p-2">⏳ جاري تحميل القيم...</div>`;
    }

    item.innerHTML = `
      <div class="filter-header">
        <span class="filter-badge">فلتر ${index + 1}</span>
        <button class="btn-icon btn-remove-filter" data-index="${index}" title="حذف">✕</button>
      </div>
      <div class="filter-body">
        <div class="filter-top-row">
          <select class="form-control filter-field-select" data-index="${index}">
            ${fieldOptionsHtml}
          </select>
          <div class="filter-mode-btns">
            <button class="btn btn-sm ${filter.mode === 'exclude' ? 'btn-danger' : 'btn-outline'} mode-btn" data-index="${index}" data-mode="exclude">🚫 استبعاد</button>
            <button class="btn btn-sm ${filter.mode === 'include' ? 'btn-success' : 'btn-outline'} mode-btn" data-index="${index}" data-mode="include">✅ عرض فقط</button>
          </div>
        </div>
        ${valuesHtml}
      </div>
    `;
    
    list.appendChild(item);
  });

  bindFilterEvents(list);
}

function bindFilterEvents(list) {
  // Remove filter
  list.querySelectorAll('.btn-remove-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      filterConfig.splice(parseInt(btn.dataset.index), 1);
      renderFilters();
      notifyFilterChanges();
    });
  });

  // Change field - fetch new values
  list.querySelectorAll('.filter-field-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const idx = parseInt(e.target.dataset.index);
      const newPath = e.target.value;
      const fieldInfo = getFieldInfo(newPath);
      
      filterConfig[idx].path = newPath;
      filterConfig[idx].label = fieldInfo.label;
      filterConfig[idx].selectedValues = [];
      filterConfig[idx].availableValues = [];
      
      renderFilters(); // Show loading state
      
      // Fetch values
      const values = await fetchFilterValues(newPath);
      filterConfig[idx].availableValues = values;
      renderFilters();
    });
  });

  // Mode buttons
  list.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      filterConfig[idx].mode = btn.dataset.mode;
      renderFilters();
      notifyFilterChanges();
    });
  });

  // Inline value checkboxes
  list.querySelectorAll('.filter-val-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.filterIndex);
      const val = cb.value;
      
      if (cb.checked) {
        if (!filterConfig[idx].selectedValues.includes(val)) {
          filterConfig[idx].selectedValues.push(val);
        }
      } else {
        filterConfig[idx].selectedValues = filterConfig[idx].selectedValues.filter(v => v !== val);
      }
      
      // Update chip visual
      const chip = cb.closest('.filter-chip');
      if (chip) chip.classList.toggle('active', cb.checked);
      
      notifyFilterChanges();
    });
  });

  // Select all / deselect all
  list.querySelectorAll('.btn-select-all-inline').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      filterConfig[idx].selectedValues = [...filterConfig[idx].availableValues];
      renderFilters();
      notifyFilterChanges();
    });
  });

  list.querySelectorAll('.btn-deselect-all-inline').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      filterConfig[idx].selectedValues = [];
      renderFilters();
      notifyFilterChanges();
    });
  });
}

// =========================================
// ENUM CUSTOM SORT MODAL
// =========================================

async function openCustomSortModal(path, configIndex) {
  const fieldInfo = getFieldInfo(path);
  let refValues = [];
  
  try {
    // Use fetchFilterValues which has the reliable fallback mechanism
    const values = await fetchFilterValues(path);
    refValues = values.map(v => ({ field_value: v }));
  } catch (err) {
    window.app.showToast('فشل تحميل القيم: ' + err.message, 'error');
    return;
  }

  const modalContent = `
    <div class="modal-header">
      <h2>ترتيب القيم: ${fieldInfo.label}</h2>
      <button class="btn-icon close-modal">✕</button>
    </div>
    <div class="modal-body">
      <p class="text-muted mb-3">قم بسحب القيم لترتيبها حسب الأولوية.</p>
      
      <div class="enum-values-list" id="modal-enum-list">
        ${refValues.map((val, i) => {
          const valStr = val.field_value || val.value || val.label || '';
          return `
            <div class="enum-val-item card" draggable="true" data-id="${valStr}">
              <span class="drag-handle icon">⋮⋮</span>
              <span class="enum-text flex-1">${valStr}</span>
              <span class="enum-order-badge">${i + 1}</span>
            </div>
          `;
        }).join('')}
      </div>
      
      <div class="modal-footer mt-4">
        <button class="btn btn-primary w-100" id="btn-save-enum-sort">حفظ الترتيب</button>
      </div>
    </div>
  `;
  
  window.app.showModal(modalContent);
  
  const list = document.getElementById('modal-enum-list');
  let draggedEnum = null;
  
  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.enum-val-item');
    if (!item) return;
    draggedEnum = item;
    setTimeout(() => item.classList.add('dragging'), 0);
  });
  list.addEventListener('dragend', () => {
    if (draggedEnum) { draggedEnum.classList.remove('dragging'); draggedEnum = null; }
    list.querySelectorAll('.enum-val-item').forEach((el, i) => {
      el.querySelector('.enum-order-badge').textContent = i + 1;
    });
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    if (!draggedEnum) return;
    const after = [...list.querySelectorAll('.enum-val-item:not(.dragging)')].reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = e.clientY - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
    if (!after) list.appendChild(draggedEnum);
    else list.insertBefore(draggedEnum, after);
  });
  
  document.getElementById('btn-save-enum-sort').addEventListener('click', async () => {
    const items = Array.from(list.querySelectorAll('.enum-val-item'));
    const orderedValues = items.map(item => item.dataset.id);
    
    sortingConfig[configIndex].customOrder = orderedValues;
    
    try {
      await updateReferenceOrder(path, orderedValues);
      window.app.showToast('تم حفظ الترتيب بنجاح', 'success');
      window.app.closeModal();
      notifySortChanges();
    } catch (err) {
      window.app.showToast('فشل الحفظ: ' + err.message, 'error');
    }
  });
}

// =========================================
// NOTIFICATIONS & EXPORTS
// =========================================

function notifySortChanges() {
  if (onSortingChangedCallback) onSortingChangedCallback(sortingConfig);
}

function notifyFilterChanges() {
  if (onFilterChangedCallback) onFilterChangedCallback(filterConfig);
}

export function getSortingConfig() { return sortingConfig; }
export function getFilterConfig() {
  // Return clean format for export/preview
  return filterConfig
    .filter(f => f.selectedValues && f.selectedValues.length > 0)
    .map(f => ({
      path: f.path,
      label: f.label,
      mode: f.mode,
      values: f.selectedValues
    }));
}

export function loadSorting(config) { sortingConfig = config || []; renderSortLevels(); }
export function loadFilters(config) { filterConfig = config || []; renderFilters(); }
export function updateAvailableColumns(columns) { /* no-op */ }
