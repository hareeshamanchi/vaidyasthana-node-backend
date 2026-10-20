/**
 * Vaidyasthana Central Permission System & Multi-Hospital Role Matrix
 * Enforces least privilege, role hierarchies, and explicit capability checks.
 */

const PERMISSIONS = {
  // Platform Owner Capabilities (Exclusive to Platform Operator)
  PLATFORM_MANAGE_HOSPITALS: "platform:manage_hospitals",
  PLATFORM_MANAGE_SUBSCRIPTIONS: "platform:manage_subscriptions",
  PLATFORM_VIEW_METRICS: "platform:view_metrics",
  PLATFORM_AUDIT_LOGS: "platform:audit_logs",
  PLATFORM_CONFIG: "platform:config",

  // Hospital-Scoped Management
  HOSPITAL_MANAGE_SETTINGS: "hospital:manage_settings",
  HOSPITAL_VIEW_SETTINGS: "hospital:view_settings",
  HOSPITAL_MANAGE_STAFF: "hospital:manage_staff",
  HOSPITAL_VIEW_STAFF: "hospital:view_staff",
  HOSPITAL_VIEW_METRICS: "hospital:view_metrics",

  // Clinical & Patient Care
  PATIENT_REGISTER: "patient:register",
  PATIENT_VIEW: "patient:view",
  PATIENT_RECORDS_VIEW: "patient_records:view",
  PATIENT_RECORDS_EDIT: "patient_records:edit",
  CLINICAL_OBSERVATIONS: "clinical:observations",

  // Appointments & Scheduling
  APPOINTMENT_SCHEDULE: "appointment:schedule",
  APPOINTMENT_VIEW: "appointment:view",
  APPOINTMENT_MANAGE: "appointment:manage",
  APPOINTMENT_CHECKIN: "appointment:checkin",
  DOCTOR_SCHEDULE_VIEW: "doctor_schedule:view",
  DOCTOR_LEAVE_MANAGE: "doctor_leave:manage",

  // Pharmacy & Prescriptions
  PRESCRIPTIONS_CREATE: "prescriptions:create",
  PRESCRIPTIONS_VIEW: "prescriptions:view",
  PRESCRIPTIONS_DISPENSE: "prescriptions:dispense",

  // Laboratory
  LAB_ORDERS_VIEW: "lab:orders_view",
  LAB_RESULTS_ENTER: "lab:results_enter",
  LAB_RESULTS_UPLOAD: "lab:results_upload",

  // Billing & Finance
  BILLING_MANAGE: "billing:manage",
  BILLING_VIEW: "billing:view",

  // Follow-ups
  FOLLOW_UP_CREATE: "follow_up:create",
  FOLLOW_UP_VIEW: "follow_up:view",
};

/**
 * Role-to-Permissions Mapping (Least Privilege, Deny-by-default)
 */
const ROLE_PERMISSIONS = {
  superadmin: Object.values(PERMISSIONS), // Superadmin has platform governance & support oversight

  hospital_admin: [
    PERMISSIONS.HOSPITAL_MANAGE_SETTINGS,
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.HOSPITAL_MANAGE_STAFF,
    PERMISSIONS.HOSPITAL_VIEW_STAFF,
    PERMISSIONS.HOSPITAL_VIEW_METRICS,
    PERMISSIONS.PATIENT_REGISTER,
    PERMISSIONS.PATIENT_VIEW,
    PERMISSIONS.APPOINTMENT_SCHEDULE,
    PERMISSIONS.APPOINTMENT_VIEW,
    PERMISSIONS.APPOINTMENT_MANAGE,
    PERMISSIONS.APPOINTMENT_CHECKIN,
    PERMISSIONS.DOCTOR_SCHEDULE_VIEW,
    PERMISSIONS.DOCTOR_LEAVE_MANAGE,
    PERMISSIONS.PRESCRIPTIONS_VIEW,
    PERMISSIONS.LAB_ORDERS_VIEW,
    PERMISSIONS.BILLING_MANAGE,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.FOLLOW_UP_VIEW,
  ],

  // Legacy admin mapping: Treated as hospital_admin capability level
  admin: [
    PERMISSIONS.HOSPITAL_MANAGE_SETTINGS,
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.HOSPITAL_MANAGE_STAFF,
    PERMISSIONS.HOSPITAL_VIEW_STAFF,
    PERMISSIONS.HOSPITAL_VIEW_METRICS,
    PERMISSIONS.PATIENT_REGISTER,
    PERMISSIONS.PATIENT_VIEW,
    PERMISSIONS.APPOINTMENT_SCHEDULE,
    PERMISSIONS.APPOINTMENT_VIEW,
    PERMISSIONS.APPOINTMENT_MANAGE,
    PERMISSIONS.APPOINTMENT_CHECKIN,
    PERMISSIONS.DOCTOR_SCHEDULE_VIEW,
    PERMISSIONS.DOCTOR_LEAVE_MANAGE,
    PERMISSIONS.PRESCRIPTIONS_VIEW,
    PERMISSIONS.LAB_ORDERS_VIEW,
    PERMISSIONS.BILLING_MANAGE,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.FOLLOW_UP_VIEW,
  ],

  doctor: [
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.PATIENT_VIEW,
    PERMISSIONS.PATIENT_RECORDS_VIEW,
    PERMISSIONS.PATIENT_RECORDS_EDIT,
    PERMISSIONS.CLINICAL_OBSERVATIONS,
    PERMISSIONS.APPOINTMENT_VIEW,
    PERMISSIONS.APPOINTMENT_MANAGE,
    PERMISSIONS.DOCTOR_SCHEDULE_VIEW,
    PERMISSIONS.DOCTOR_LEAVE_MANAGE,
    PERMISSIONS.PRESCRIPTIONS_CREATE,
    PERMISSIONS.PRESCRIPTIONS_VIEW,
    PERMISSIONS.LAB_ORDERS_VIEW,
    PERMISSIONS.FOLLOW_UP_CREATE,
    PERMISSIONS.FOLLOW_UP_VIEW,
    PERMISSIONS.PATIENT_REGISTER,
  ],

  nurse: [
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.PATIENT_VIEW,
    PERMISSIONS.PATIENT_RECORDS_VIEW,
    PERMISSIONS.CLINICAL_OBSERVATIONS,
    PERMISSIONS.APPOINTMENT_VIEW,
    PERMISSIONS.DOCTOR_SCHEDULE_VIEW,
    PERMISSIONS.PRESCRIPTIONS_VIEW,
    PERMISSIONS.FOLLOW_UP_VIEW,
  ],

  receptionist: [
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.PATIENT_REGISTER,
    PERMISSIONS.PATIENT_VIEW,
    PERMISSIONS.APPOINTMENT_SCHEDULE,
    PERMISSIONS.APPOINTMENT_VIEW,
    PERMISSIONS.APPOINTMENT_CHECKIN,
    PERMISSIONS.DOCTOR_SCHEDULE_VIEW,
    PERMISSIONS.BILLING_VIEW,
  ],

  lab_technician: [
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.LAB_ORDERS_VIEW,
    PERMISSIONS.LAB_RESULTS_ENTER,
    PERMISSIONS.LAB_RESULTS_UPLOAD,
    PERMISSIONS.PATIENT_VIEW,
  ],

  pharmacist: [
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.PRESCRIPTIONS_VIEW,
    PERMISSIONS.PRESCRIPTIONS_DISPENSE,
    PERMISSIONS.PATIENT_VIEW,
  ],

  billing_staff: [
    PERMISSIONS.HOSPITAL_VIEW_SETTINGS,
    PERMISSIONS.BILLING_MANAGE,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.PATIENT_VIEW,
    PERMISSIONS.APPOINTMENT_VIEW,
  ],

  patient: [
    PERMISSIONS.APPOINTMENT_SCHEDULE,
    PERMISSIONS.APPOINTMENT_VIEW,
    PERMISSIONS.PATIENT_RECORDS_VIEW,
    PERMISSIONS.PRESCRIPTIONS_VIEW,
    PERMISSIONS.FOLLOW_UP_VIEW,
  ],
};

/**
 * Roles that belong to hospital operations staff
 */
const HOSPITAL_STAFF_ROLES = [
  "doctor",
  "nurse",
  "receptionist",
  "lab_technician",
  "pharmacist",
  "billing_staff",
];

/**
 * Check if a given role has a specific permission
 */
const hasPermission = (role, permission) => {
  if (!role || !permission) return false;
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permission);
};

/**
 * Determines which roles an actor is authorized to assign or manage
 */
const getAllowedAssignableRoles = (actorRole) => {
  if (actorRole === "superadmin") {
    return [
      "hospital_admin",
      "doctor",
      "nurse",
      "receptionist",
      "lab_technician",
      "pharmacist",
      "billing_staff",
      "patient",
    ];
  }
  if (actorRole === "hospital_admin" || actorRole === "admin") {
    // Hospital admins can ONLY assign staff roles within their hospital
    return [...HOSPITAL_STAFF_ROLES];
  }
  return [];
};

/**
 * Validates whether actorRole can assign or modify targetRole
 */
const canManageRole = (actorRole, targetRole) => {
  const allowed = getAllowedAssignableRoles(actorRole);
  return allowed.includes(targetRole);
};

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  HOSPITAL_STAFF_ROLES,
  hasPermission,
  getAllowedAssignableRoles,
  canManageRole,
};
