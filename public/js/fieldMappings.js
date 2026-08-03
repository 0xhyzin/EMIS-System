export const FIELD_GROUPS = {
  basicInfo: {
    label: 'البيانات الأساسية',
    icon: '👤',
    fields: {
      'basicInfo.empCode': { label: 'كود الموظف', type: 'number' },
      'basicInfo.nationalIdNum': { label: 'الرقم القومي', type: 'number' },
      'basicInfo.empFirstName': { label: 'الاسم الأول', type: 'text' },
      'basicInfo.empFatherName': { label: 'اسم الأب', type: 'text' },
      'basicInfo.empGrandFatherName': { label: 'اسم الجد', type: 'text' },
      'basicInfo.empFamilyName': { label: 'اسم العائلة', type: 'text' },
      'basicInfo.empBirthDate': { label: 'تاريخ الميلاد', type: 'date' },
      'basicInfo.birthDesc': { label: 'محل الميلاد', type: 'text' },
      'basicInfo.genderDesc': { label: 'النوع', type: 'enum' },
      'basicInfo.empReligion': { label: 'الديانة', type: 'enum' },
      'basicInfo.martStatDesc': { label: 'الحالة الاجتماعية', type: 'enum' },
      'basicInfo.empMobile': { label: 'رقم الموبايل', type: 'text' },
      'basicInfo.addressDesc': { label: 'العنوان', type: 'text' },
      'basicInfo.recruitmentTypeDesc': { label: 'نوع التعيين', type: 'enum' },
      'basicInfo.edaraName': { label: 'الإدارة', type: 'text' },
      'basicInfo.schoolName': { label: 'المدرسة', type: 'text' },
      'basicInfo.stageName': { label: 'المرحلة', type: 'enum' },
      'basicInfo.empStartDate': { label: 'تاريخ بدء العمل', type: 'date' },
      'basicInfo.empHiredate': { label: 'تاريخ التعيين', type: 'date' },
      'basicInfo.orgMudriaName': { label: 'المحافظة / المديرية', type: 'text' },
      'basicInfo.terminateID': { label: 'حالة إنهاء الخدمة', type: 'text' },
      'basicInfo.empEmail': { label: 'البريد الإلكتروني', type: 'text' },
    }
  },
  qualification: {
    label: 'المؤهل الدراسي',
    icon: '🎓',
    fields: {
      'qlf.qlfName': { label: 'المؤهل', type: 'enum' },
      'qlf.qlfTypeName': { label: 'نوع المؤهل', type: 'enum' },
      'qlf.qlfEntityName': { label: 'جهة التخرج', type: 'enum' },
      'qlf.qlfGradDesc': { label: 'تقدير المؤهل', type: 'enum' },
      'qlf.empQlfDate': { label: 'تاريخ المؤهل', type: 'date' },
    }
  },
  job: {
    label: 'الوظيفة والكادر',
    icon: '💼',
    fields: {
      'job.degreeDesc': { label: 'الدرجة الوظيفية', type: 'enum' },
      'job.jobClassDesc': { label: 'المجموعة النوعية', type: 'enum' },
      'job.jobDesc': { label: 'الوظيفة على الكادر', type: 'enum' },
      'job.subjectDesc': { label: 'المادة / التخصص', type: 'enum' },
      'job.stageDesc': { label: 'المرحلة الدراسية', type: 'enum' },
      'job.degreeDescDate': { label: 'تاريخ الدرجة', type: 'date' },
      'job.kadrJobDecDate2': { label: 'تاريخ قرار الكادر', type: 'date' },
      'job.kadrJobStartDate': { label: 'تاريخ بدء الكادر', type: 'date' },
      'job.kadrJobDecNum2': { label: 'رقم قرار الكادر', type: 'number' },
      'job.degreeDescNum': { label: 'رقم قرار الدرجة', type: 'number' },
      'job.jobDescDate': { label: 'تاريخ قرار الوظيفة', type: 'date' },
      'job.jobDescNumber': { label: 'رقم قرار الوظيفة', type: 'number' },
    }
  },
  secondment: {
    label: 'بيانات الندب',
    icon: '🔄',
    fields: {
      'secondment.empFlag': { label: 'نوع الندب', type: 'text' },
      'secondment.jobName': { label: 'الوظيفة', type: 'text' },
      'secondment.fromMudriaName': { label: 'المديرية الأصلية', type: 'text' },
      'secondment.fromEdaraName': { label: 'الإدارة الأصلية', type: 'text' },
      'secondment.fromGehaName': { label: 'الجهة الأصلية', type: 'text' },
      'secondment.toMudriaName': { label: 'مديرية الندب', type: 'text' },
      'secondment.toEdaraName': { label: 'إدارة الندب', type: 'text' },
      'secondment.toGehaName': { label: 'جهة الندب', type: 'text' },
    }
  }
};

export const MERGE_TEMPLATES = [
  {
    id: 'fullName',
    label: 'الاسم بالكامل',
    fields: ['basicInfo.empFirstName', 'basicInfo.empFatherName', 'basicInfo.empGrandFatherName', 'basicInfo.empFamilyName'],
    separator: ' '
  },
  {
    id: 'qlfWithDate',
    label: 'المؤهل وتاريخه',
    fields: ['qlf.qlfName', 'qlf.empQlfDate'],
    separator: ' - '
  },
  {
    id: 'jobWithDate',
    label: 'الوظيفة على الكادر وتاريخها',
    fields: ['job.jobDesc', 'job.kadrJobStartDate'],
    separator: ' - '
  },
  {
    id: 'degreeWithDate',
    label: 'الدرجة وتاريخها',
    fields: ['job.degreeDesc', 'job.degreeDescDate'],
    separator: ' - '
  },
  {
    id: 'jobWithStartDate',
    label: 'الوظيفة على الكادر وتاريخ البدء',
    fields: ['job.jobDesc', 'job.kadrJobStartDate'],
    separator: ' - '
  }
];

export function getFieldValue(employee, fieldPath) {
  if (fieldPath === 'index') return ''; // Handled separately
  
  const parts = fieldPath.split('.');
  let value = employee;
  for (const part of parts) {
    if (value == null) return '';
    value = value[part];
  }
  if (value == null) return '';
  
  if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
    const d = new Date(value);
    if (!isNaN(d.getTime()) && d.getFullYear() > 1900) {
      return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
    }
    return '';
  }
  return String(value);
}

export function getFieldInfo(fieldPath) {
  if (fieldPath === 'index') return { label: 'م', type: 'number' };
  
  for (const group of Object.values(FIELD_GROUPS)) {
    if (group.fields[fieldPath]) return group.fields[fieldPath];
  }
  return { label: fieldPath, type: 'text' };
}

export function getAllFields() {
  const result = [];
  for (const [groupKey, group] of Object.entries(FIELD_GROUPS)) {
    for (const [fieldPath, info] of Object.entries(group.fields)) {
      result.push({ path: fieldPath, ...info, group: group.label, groupIcon: group.icon });
    }
  }
  return result;
}
