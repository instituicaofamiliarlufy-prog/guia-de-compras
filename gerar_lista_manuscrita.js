import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";

// Configuração do teu Firebase
const firebaseConfig = {
  apiKey:            "AIzaSyCGzgFbleV3H6tZpOEW0voPke0LY9VTJs8",
  authDomain:        "guia-de-compras-2f883.firebaseapp.com",
  projectId:         "guia-de-compras-2f883",
  storageBucket:     "guia-de-compras-2f883.firebasestorage.app",
  messagingSenderId: "375038437557",
  appId:             "1:375038437557:web:f3e21dc6f40b2a04e076fc"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Dados com 'catId' canonizados (kebab-case) para bater certo com a base de dados
const itensParaImportar = [
  { original: "óleo vegetal", canon: "Óleo de Soja Fula 1L", catId: "graos-e-mercearia", preco: 2150, unit: "un" },
  { original: "açúcar", canon: "Açúcar branco Patriota 1kg", catId: "graos-e-mercearia", preco: 949, unit: "un" },
  { original: "limão", canon: "LIMAO NACIONAL KG", catId: "frutas-legumes-e-verduras", preco: 2000, unit: "kg" },
  { original: "cebola", canon: "CEBOLA NACIONAL KG", catId: "frutas-legumes-e-verduras", preco: 1100, unit: "kg" },
  { original: "coxa", canon: "Coxa de Frango Pkt 5kg", catId: "talho-e-congelados", preco: 7500, unit: "pack" },
  { original: "vinho", canon: "VINHO TINTO ALENTEJANO EA 750ML", catId: "bebidas", preco: 4850, unit: "un" },
  { original: "linguiça", canon: "LINGUICA CHURRASCO PORKU'S 500G", catId: "talho-e-congelados", preco: 3200, unit: "un" },
  { original: "gasosa", canon: "LIMA-LIMAO LATA 7UP - 24 X 330 ML", catId: "bebidas", preco: 479, unit: "un" },
  { original: "água pequena", canon: "Agua Bom Jesus 12x500ml", catId: "bebidas", preco: 1699, unit: "un" },
  { original: "leite", canon: "Leite Gordo Mimosa 1L", catId: "laticinios-e-frios", preco: 850, unit: "un" },
  { original: "cerveja", canon: "CERVEJA TIGRA LATA 33CL", catId: "bebidas", preco: 350, unit: "un" },
  
  // Produtos órfãos da nota manuscrita que faltavam:
  { original: "fermento p/ bolo", canon: "Fermento p/ Bolo", catId: "graos-e-mercearia", preco: 500, unit: "un" },
  { original: "ovos", canon: "Ovos Dúzia", catId: "laticinios-e-frios", preco: 1200, unit: "un" },
  { original: "papel alumínio e aderente", canon: "Papel Alumínio", catId: "higiene-e-limpeza", preco: 800, unit: "un" }
];

async function importarLista() {
  const itensListaFinal = {};
  const produtosPorCategoria = {};

  // Agrupar produtos por categoria para facilitar as queries ao Firestore
  for (const item of itensParaImportar) {
    if (!produtosPorCategoria[item.catId]) {
      produtosPorCategoria[item.catId] = [];
    }
    produtosPorCategoria[item.catId].push(item);
  }

  // Processar cada categoria individualmente na coleção "catalogo"
  console.log("🚀 A verificar catálogo no Firestore...");
  for (const [catId, produtos] of Object.entries(produtosPorCategoria)) {
    const catRef = doc(db, "catalogo", catId);
    const catSnap = await getDoc(catRef);
    
    // Se a categoria não existir, prepara uma nova estrutura
    let catData = catSnap.exists() ? catSnap.data() : { nome: catId.replace(/-/g, ' '), items: [] };
    let categoriaAtualizada = false;

    for (const item of produtos) {
      // Verifica se o produto já existe nesta categoria
      let idx = catData.items.findIndex(i => i.name === item.canon);
      
      if (idx === -1) {
        console.log(`  [+] Adicionando novo produto: ${item.canon}`);
        catData.items.push({
          name: item.canon,
          preco: item.preco,
          unit: item.unit,
          defaultQty: 1,
          bestShopId: "vários"
        });
        idx = catData.items.length - 1;
        categoriaAtualizada = true;
      }

      // Constrói a referência para a lista no formato que o app.js exige (ex: bebidas__3)
      const itemKey = `${catId}__${idx}`;
      itensListaFinal[itemKey] = {
        catId: catId,
        itemIdx: idx,
        qty: 1,
        checked: false
      };
    }

    // Apenas grava no Firestore se tivermos adicionado produtos novos à categoria
    if (categoriaAtualizada) {
      await setDoc(catRef, catData);
    }
  }

  // Criar a nova lista de compras
  const dataHoje = new Date().toISOString().split('T')[0];
  const listaId = `lista-${dataHoje}-${Date.now()}`;
  
  const novaLista = {
    nome: "Lista Manuscrita - Importada",
    date: dataHoje,
    supermercado: "vários",
    items: itensListaFinal
  };

  await setDoc(doc(db, "listas", listaId), novaLista);
  
  console.log(`\n✅ Sucesso! Catálogo atualizado e lista criada com ID: ${listaId}`);
  process.exit(0);
}

importarLista().catch(console.error);