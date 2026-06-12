// ══════════════════════════════════════════════════════════════════
//  db.js — Originais Pizza · Firebase Integration
//  Substitui toda a lógica de localStorage por Firebase Auth +
//  Firestore. Importe este arquivo ANTES do script principal no
//  index.html.
//
//  Como usar:
//    <script type="module" src="db.js"></script>
//    <script type="module" src="app.js"></script>  ← seu script atual
//
//  ⚠️  Troque os valores de firebaseConfig pelos do seu projeto.
// ══════════════════════════════════════════════════════════════════

import { initializeApp }                        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, doc,
         setDoc, getDoc, getDocs, addDoc,
         updateDoc, query, orderBy,
         limit, onSnapshot, serverTimestamp }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword,
         signInWithEmailAndPassword,
         signOut, onAuthStateChanged }          from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// ──────────────────────────────────────────────
//  🔧 CONFIGURAÇÃO — substitua pelos seus dados
// ──────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCQRF0X7DgDm1J4SasVV-Qf1kjm2x6nSTY",
  authDomain: "pizza-projeto-do-ano.firebaseapp.com",
  projectId: "pizza-projeto-do-ano",
  storageBucket: "pizza-projeto-do-ano.firebasestorage.app",
  messagingSenderId: "197719316348",
  appId: "1:197719316348:web:f66109050fcddb2f7d76f9"
};

// ──────────────────────────────────────────────
//  Inicialização
// ──────────────────────────────────────────────
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// ──────────────────────────────────────────────
//  Administradores fixos (não usam Firebase Auth;
//  autenticação é feita por lookup na coleção
//  "admins" no Firestore)
// ──────────────────────────────────────────────
const ADMINS_LOCAL = [
  { id: 1, name: "Pedro Luiz",          email: "pedro@originaispizza.com",          password: "adm@pedro2026",          level: "Super ADM" },
  { id: 2, name: "Arthur Ferruci",      email: "arthur@originaispizza.com",         password: "adm@arthur2026",         level: "Super ADM" },
  { id: 3, name: "Guilherme Honorato",  email: "guilherme@originaispizza.com",      password: "adm@guilherme2026",      level: "ADM" },
  { id: 4, name: "Pedro Henrique",      email: "pedrohenrique@originaispizza.com",  password: "adm@pedrohenrique2026",  level: "ADM" },
];

// ══════════════════════════════════════════════
//  COLEÇÕES DO FIRESTORE
//
//  /users/{uid}          → dados do usuário
//  /activities/{docId}   → log de atividades
//  /stats/global         → contadores (logins, cadastros, semana)
// ══════════════════════════════════════════════

// ──────────────────────────────────────────────
//  AUTH — Cadastro de usuário
// ──────────────────────────────────────────────

/**
 * Cadastra um novo usuário no Firebase Auth e salva os dados
 * extras no Firestore (CPF, endereço, pagamento etc.).
 *
 * @param {Object} userData  Campos do formulário de cadastro
 * @returns {Object} { success: true, user } | { success: false, error }
 */
export async function registerUser(userData) {
  const { name, cpf, email, address, password,
          payment, card, expiry } = userData;

  try {
    // 1. Cria conta no Firebase Auth
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const uid = credential.user.uid;

    // 2. Salva perfil completo no Firestore
    await setDoc(doc(db, "users", uid), {
      uid,
      name,
      cpf,
      email,
      address,
      payment,
      card:     card   || "—",
      expiry:   expiry || "—",
      loginCount:   0,
      lastLogin:    null,
      registeredAt: serverTimestamp(),
      active:       true,
    });

    // 3. Incrementa contador de cadastros de hoje
    await _incrementStat("registersToday", 1);
    await _incrementWeekDay(1);

    // 4. Registra no log de atividades
    await logActivity("register", name, "Novo usuário cadastrado");

    return { success: true, user: credential.user };

  } catch (err) {
    console.error("[db.js] registerUser:", err);
    return { success: false, error: _translateAuthError(err.code) };
  }
}

// ──────────────────────────────────────────────
//  AUTH — Login de usuário comum
// ──────────────────────────────────────────────

/**
 * Autentica um usuário comum via Firebase Auth.
 * Após login, atualiza loginCount e lastLogin no Firestore.
 *
 * @returns {Object} { success, user, profile } | { success: false, error }
 */
export async function loginUser(email, password) {
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const uid = credential.user.uid;

    // Atualiza contadores do usuário
    const userRef = doc(db, "users", uid);
    const snap    = await getDoc(userRef);

    if (snap.exists()) {
      const data = snap.data();
      await updateDoc(userRef, {
        loginCount: (data.loginCount || 0) + 1,
        lastLogin:  serverTimestamp(),
      });
    }

    await _incrementStat("loginCountToday", 1);
    await _incrementWeekDay(1);
    await logActivity("login", snap.data()?.name || email, "Usuário fez login");

    return { success: true, user: credential.user, profile: snap.data() };

  } catch (err) {
    console.error("[db.js] loginUser:", err);
    return { success: false, error: _translateAuthError(err.code) };
  }
}

// ──────────────────────────────────────────────
//  AUTH — Login de administrador (sem Firebase Auth)
// ──────────────────────────────────────────────

/**
 * Valida credenciais de administrador localmente e registra
 * o acesso no Firestore.
 *
 * @returns {Object} { success, admin } | { success: false, error }
 */
export async function loginAdmin(email, password) {
  const adm = ADMINS_LOCAL.find(a => a.email === email && a.password === password);
  if (!adm) {
    return { success: false, error: "E-mail ou senha incorretos." };
  }

  try {
    // Salva/atualiza último acesso na coleção "admins"
    await setDoc(doc(db, "admins", String(adm.id)), {
      id:         adm.id,
      name:       adm.name,
      email:      adm.email,
      level:      adm.level,
      lastAccess: serverTimestamp(),
    }, { merge: true });

    await _incrementStat("loginCountToday", 1);
    await logActivity("login", adm.name, "Administrador fez login");

    return { success: true, admin: adm };

  } catch (err) {
    console.error("[db.js] loginAdmin:", err);
    // Mesmo com erro no Firestore, permite login local
    return { success: true, admin: adm };
  }
}

// ──────────────────────────────────────────────
//  AUTH — Logout
// ──────────────────────────────────────────────

/**
 * Encerra a sessão do usuário comum no Firebase Auth.
 * Para admins basta limpar o estado local (eles não usam Auth).
 */
export async function logoutUser(userName = "Usuário") {
  try {
    await logActivity("logout", userName, "Usuário encerrou a sessão");
    await signOut(auth);
    return { success: true };
  } catch (err) {
    console.error("[db.js] logoutUser:", err);
    return { success: false, error: err.message };
  }
}

// ──────────────────────────────────────────────
//  AUTH — Observer de estado de autenticação
// ──────────────────────────────────────────────

/**
 * Escuta mudanças de estado de autenticação (login / logout automático).
 * Use para manter a UI sincronizada com a sessão do Firebase.
 *
 * @param {Function} callback  Chamada com (user) quando o estado muda.
 *                             user é null quando deslogado.
 *
 * Exemplo de uso no index.html:
 *   onAuthChange(user => {
 *     currentUser = user ? { name: ..., email: user.email } : null;
 *     updateNav();
 *   });
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ══════════════════════════════════════════════
//  FIRESTORE — Leitura de dados
// ══════════════════════════════════════════════

/**
 * Busca o perfil completo de um usuário pelo UID.
 *
 * @returns {Object|null}
 */
export async function getUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
  } catch (err) {
    console.error("[db.js] getUserProfile:", err);
    return null;
  }
}

/**
 * Busca todos os usuários cadastrados.
 * Usado na tabela do dashboard.
 *
 * @returns {Array}
 */
export async function getAllUsers() {
  try {
    const snap = await getDocs(collection(db, "users"));
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  } catch (err) {
    console.error("[db.js] getAllUsers:", err);
    return [];
  }
}

/**
 * Busca dados de todos os administradores (último acesso etc.).
 *
 * @returns {Array}
 */
export async function getAllAdmins() {
  try {
    const snap = await getDocs(collection(db, "admins"));
    return snap.docs.map(d => ({ ...d.data() }));
  } catch (err) {
    console.error("[db.js] getAllAdmins:", err);
    return [];
  }
}

/**
 * Busca os N registros mais recentes do log de atividades.
 *
 * @param {number} max  Padrão: 50
 * @returns {Array}
 */
export async function getActivities(max = 50) {
  try {
    const q    = query(collection(db, "activities"), orderBy("timestamp", "desc"), limit(max));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[db.js] getActivities:", err);
    return [];
  }
}

/**
 * Escuta o log de atividades em tempo real.
 * Ideal para o feed ao vivo do dashboard.
 *
 * @param {Function} callback  Chamada com (activities[]) a cada update.
 * @returns {Function}         Função para cancelar o listener (unsubscribe).
 *
 * Exemplo:
 *   const unsub = onActivitiesChange(list => renderActivityFeed(list));
 *   // Para parar: unsub();
 */
export function onActivitiesChange(callback, max = 50) {
  const q = query(collection(db, "activities"), orderBy("timestamp", "desc"), limit(max));
  return onSnapshot(q, snap => {
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(list);
  });
}

/**
 * Busca os contadores globais (logins hoje, cadastros hoje, semana).
 *
 * @returns {Object} { loginCountToday, registersToday, weekData }
 */
export async function getStats() {
  try {
    const snap = await getDoc(doc(db, "stats", "global"));
    if (snap.exists()) return snap.data();
    return { loginCountToday: 0, registersToday: 0, weekData: [0,0,0,0,0,0,0] };
  } catch (err) {
    console.error("[db.js] getStats:", err);
    return { loginCountToday: 0, registersToday: 0, weekData: [0,0,0,0,0,0,0] };
  }
}

// ══════════════════════════════════════════════
//  FIRESTORE — Escrita / Atualização
// ══════════════════════════════════════════════

/**
 * Adiciona uma entrada no log de atividades.
 *
 * @param {"login"|"logout"|"register"} type
 * @param {string} userName
 * @param {string} description
 */
export async function logActivity(type, userName, description) {
  try {
    await addDoc(collection(db, "activities"), {
      type,
      user:        userName,
      description,
      timestamp:   serverTimestamp(),
      // Campos formatados para exibição imediata (antes do serverTimestamp resolver)
      timeFmt: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      dateFmt: new Date().toLocaleDateString("pt-BR"),
    });
  } catch (err) {
    console.error("[db.js] logActivity:", err);
  }
}

// ══════════════════════════════════════════════
//  UTILITÁRIOS INTERNOS (privados)
// ══════════════════════════════════════════════

async function _incrementStat(field, amount = 1) {
  const ref  = doc(db, "stats", "global");
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  await setDoc(ref, { ...data, [field]: (data[field] || 0) + amount }, { merge: true });
}

async function _incrementWeekDay(amount = 1) {
  const ref  = doc(db, "stats", "global");
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : {};
  const week = data.weekData || [0, 0, 0, 0, 0, 0, 0];
  const day  = new Date().getDay(); // 0=Dom … 6=Sáb
  week[day]  = (week[day] || 0) + amount;
  await setDoc(ref, { ...data, weekData: week }, { merge: true });
}

function _translateAuthError(code) {
  const map = {
    "auth/email-already-in-use":    "Este e-mail já está cadastrado.",
    "auth/invalid-email":           "E-mail inválido.",
    "auth/weak-password":           "A senha precisa ter pelo menos 6 caracteres.",
    "auth/user-not-found":          "E-mail ou senha incorretos.",
    "auth/wrong-password":          "E-mail ou senha incorretos.",
    "auth/too-many-requests":       "Muitas tentativas. Tente novamente mais tarde.",
    "auth/network-request-failed":  "Erro de conexão. Verifique sua internet.",
  };
  return map[code] || "Ocorreu um erro inesperado. Tente novamente.";
}

// ══════════════════════════════════════════════
//  EXPORTS — resumo de tudo que está disponível
// ══════════════════════════════════════════════
//
//  Auth:
//    registerUser(userData)          → cadastra usuário
//    loginUser(email, password)      → login usuário comum
//    loginAdmin(email, password)     → login administrador
//    logoutUser(userName)            → logout
//    onAuthChange(callback)          → observer de sessão
//
//  Leitura:
//    getUserProfile(uid)             → perfil de um usuário
//    getAllUsers()                   → todos os usuários
//    getAllAdmins()                  → todos os admins com último acesso
//    getActivities(max?)             → log de atividades (leitura única)
//    onActivitiesChange(cb, max?)    → log em tempo real (listener)
//    getStats()                      → contadores globais
//
//  Escrita:
//    logActivity(type, user, desc)  → adiciona entrada no log
//
// ══════════════════════════════════════════════
