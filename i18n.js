(function () {
    'use strict';

    var KEY = 'ff_lang';
    var CODES = ['en', 'es', 'fr', 'de', 'ja'];

    // Page names are shared: the header, the drawer and the footer all point at the
    // same pages, so they read the same key. The tab bar keeps its own short labels
    // because four of them have to fit across a 320px phone.
    var STRINGS = {
        'page.home': { en: 'Home', es: 'Inicio', fr: 'Accueil', de: 'Start', ja: 'ホーム' },
        'page.scanner': { en: 'Scanner', es: 'Escáner', ja: 'スキャナー' },
        'page.try': { en: 'Try Now', es: 'Probar ahora', fr: 'Essayer', de: 'Jetzt testen', ja: '使ってみる' },
        'page.dashboard': { en: 'Dashboard', es: 'Panel', fr: 'Journal', de: 'Übersicht', ja: 'ダッシュボード' },
        'page.profile': { en: 'Profile', es: 'Perfil', fr: 'Profil', de: 'Profil', ja: 'プロフィール' },
        'page.directory': { en: 'Directory', es: 'Directorio', fr: 'Répertoire', de: 'Verzeichnis', ja: '図鑑' },
        'page.how': { en: 'How it works', es: 'Cómo funciona', fr: 'Fonctionnement', de: 'So geht\'s', ja: '使い方' },
        'page.pricing': { en: 'Pricing', es: 'Precios', fr: 'Tarifs', de: 'Preise', ja: '料金' },
        'page.api': { en: 'API' },
        'page.docs': { en: 'Docs', es: 'Documentación', fr: 'Documentation', de: 'Dokumentation', ja: 'ドキュメント' },
        'page.data': { en: 'Data', es: 'Datos', fr: 'Données', de: 'Daten', ja: 'データ' },
        'page.research': { en: 'Research', es: 'Investigación', fr: 'Recherche', de: 'Forschung', ja: '研究' },
        'page.blogs': { en: 'Blogs', ja: 'ブログ' },
        'page.releases': { en: 'Release Notes', es: 'Notas de versión', fr: 'Notes de version', de: 'Änderungen', ja: '更新履歴' },
        'page.community': { en: 'Community', es: 'Comunidad', fr: 'Communauté', ja: 'コミュニティ' },
        'page.contribute': { en: 'Contribute', es: 'Contribuir', fr: 'Contribuer', de: 'Mitmachen', ja: '写真を送る' },
        'page.about': { en: 'About', es: 'Acerca de', fr: 'À propos', de: 'Über', ja: '概要' },
        'page.contact': { en: 'Contact', es: 'Contacto', fr: 'Contact', de: 'Kontakt', ja: 'お問い合わせ' },
        'page.privacy': { en: 'Privacy Policy', es: 'Política de privacidad', fr: 'Confidentialité', de: 'Datenschutz', ja: 'プライバシーポリシー' },
        'page.terms': { en: 'Terms of Service', es: 'Términos del servicio', fr: 'Conditions d\'utilisation', de: 'Nutzungsbedingungen', ja: '利用規約' },

        'tab.home': { en: 'Home', es: 'Inicio', fr: 'Accueil', de: 'Start', ja: 'ホーム' },
        'tab.scan': { en: 'Scan', es: 'Escanear', fr: 'Scanner', de: 'Scannen', ja: 'スキャン' },
        'tab.directory': { en: 'Directory', es: 'Directorio', fr: 'Répertoire', de: 'Verzeichnis', ja: '図鑑' },
        'tab.dashboard': { en: 'Dashboard', es: 'Panel', fr: 'Journal', de: 'Übersicht', ja: 'マイ記録' },
        'tab.label': { en: 'Primary', es: 'Principal', fr: 'Principal', de: 'Hauptnavigation', ja: 'メインナビゲーション' },

        'nav.signin': { en: 'Sign In', es: 'Iniciar sesión', fr: 'Se connecter', de: 'Anmelden', ja: 'ログイン' },
        'nav.menu.open': { en: 'Open menu', es: 'Abrir menú', fr: 'Ouvrir le menu', de: 'Menü öffnen', ja: 'メニューを開く' },
        'nav.menu.close': { en: 'Close menu', es: 'Cerrar menú', fr: 'Fermer le menu', de: 'Menü schließen', ja: 'メニューを閉じる' },

        'drawer.title': { en: 'Menu', es: 'Menú', fr: 'Menu', de: 'Menü', ja: 'メニュー' },
        'drawer.pages': { en: 'All pages', es: 'Todas las páginas', fr: 'Toutes les pages', de: 'Alle Seiten', ja: 'すべてのページ' },
        'drawer.language': { en: 'Language', es: 'Idioma', fr: 'Langue', de: 'Sprache', ja: '言語' },
        'drawer.account': {
            en: 'Sign in to keep your finds under your own account.',
            es: 'Inicia sesión para guardar tus hallazgos en tu propia cuenta.',
            fr: 'Connectez-vous pour conserver vos trouvailles sur votre compte.',
            de: 'Melde dich an, um deine Funde in deinem eigenen Konto zu behalten.',
            ja: 'サインインすると、見つけた花を自分のアカウントに残せます。'
        },
        'drawer.install.note': {
            en: 'Put FindFlower on your home screen and open it in its own window.',
            es: 'Añade FindFlower a tu pantalla de inicio y ábrelo en su propia ventana.',
            fr: 'Ajoutez FindFlower à votre écran d\'accueil et ouvrez-le dans sa propre fenêtre.',
            de: 'Lege FindFlower auf deinen Startbildschirm und öffne es in einem eigenen Fenster.',
            ja: 'FindFlower をホーム画面に追加すると、独立したウィンドウで開けます。'
        },
        'drawer.install.button': { en: 'Install app', es: 'Instalar app', fr: 'Installer l\'app', de: 'App installieren', ja: 'アプリを追加' },

        'notice.full': {
            en: 'Active development on FindFlower is temporarily paused until October 1st for scheduled backend scaling and infrastructure upgrades.',
            es: 'El desarrollo de FindFlower está pausado temporalmente hasta el 1 de octubre por trabajos previstos de escalado del backend y mejoras de la infraestructura.',
            fr: 'Le développement de FindFlower est temporairement suspendu jusqu\'au 1er octobre, le temps de mettre le backend à l\'échelle et de moderniser l\'infrastructure.',
            de: 'Die Arbeit an FindFlower pausiert bis zum 1. Oktober: Das Backend wird skaliert und die Infrastruktur erneuert.',
            ja: 'FindFlower の開発は、バックエンドの増強とインフラ更新のため 10月1日まで一時休止しています。'
        },
        'notice.brief': {
            en: 'Development is paused until October 1st for backend scaling.',
            es: 'Desarrollo pausado hasta el 1 de octubre por el escalado del backend.',
            fr: 'Développement suspendu jusqu\'au 1er octobre pour la mise à l\'échelle du backend.',
            de: 'Entwicklung bis 1. Oktober pausiert, das Backend wird skaliert.',
            ja: 'バックエンド増強のため、10月1日まで開発を休止しています。'
        },
        'notice.dismiss': { en: 'Dismiss this notice', es: 'Cerrar este aviso', fr: 'Fermer cet avis', de: 'Hinweis ausblenden', ja: 'この通知を閉じる' },

        'home.hero.title': {
            en: 'The botanical web app for flowers you cannot name',
            es: 'La aplicación botánica para las flores que no sabes nombrar',
            fr: 'L\'application botanique pour les fleurs dont vous ignorez le nom',
            de: 'Die botanische Web-App für Blumen, deren Namen du nicht kennst',
            ja: '名前のわからない花を調べる植物アプリ'
        },
        'home.hero.lead': {
            en: 'Take a photo of a flower and get the species name, how sure the answer is, and the record behind it.',
            es: 'Haz una foto de una flor y obtén el nombre de la especie, el grado de certeza de la respuesta y la ficha que la respalda.',
            fr: 'Photographiez une fleur et obtenez le nom de l\'espèce, le degré de certitude de la réponse et la fiche qui va avec.',
            de: 'Fotografiere eine Blume und du bekommst den Artnamen, wie sicher die Antwort ist und den Datensatz dahinter.',
            ja: '花の写真を撮ると、種名と回答の確度、そのもとになった記録が返ってきます。'
        },
        'home.hero.sub': {
            en: 'An installable Progressive Web App with on-device AI. Free in beta.',
            es: 'Una aplicación web progresiva instalable con IA en el dispositivo. Gratis en fase beta.',
            fr: 'Une Progressive Web App installable avec une IA embarquée. Gratuit en version bêta.',
            de: 'Eine installierbare Progressive Web App mit KI auf dem Gerät. In der Beta kostenlos.',
            ja: '端末の中で動く AI を備えた、インストールできるプログレッシブウェブアプリ。ベータ版は無料です。'
        },
        'home.hero.scan': { en: 'Open the scanner', es: 'Abrir el escáner', fr: 'Ouvrir le scanner', de: 'Scanner öffnen', ja: 'スキャナーを開く' },
        'home.hero.directory': { en: 'Explore the directory', es: 'Explorar el directorio', fr: 'Explorer le répertoire', de: 'Verzeichnis durchsuchen', ja: '図鑑を見る' },
        'home.hero.install': { en: 'Install the app', es: 'Instalar la aplicación', fr: 'Installer l\'application', de: 'App installieren', ja: 'アプリをインストール' },
        'home.hero.fine': {
            en: 'Works in any browser. The photo is sent to the server to be identified and is not kept afterwards.',
            es: 'Funciona en cualquier navegador. La foto se envía al servidor para identificarla y no se conserva después.',
            fr: 'Fonctionne dans n\'importe quel navigateur. La photo est envoyée au serveur pour être identifiée, puis elle n\'est pas conservée.',
            de: 'Läuft in jedem Browser. Das Foto geht zur Bestimmung an den Server und wird danach nicht gespeichert.',
            ja: 'どのブラウザでも動きます。写真は判定のためにサーバーへ送られ、そのあとは保存されません。'
        },
        'home.hero.privacy': { en: 'What happens to it', es: 'Qué pasa con ella', fr: 'Ce qu\'elle devient', de: 'Was damit passiert', ja: '写真の取り扱い' },

        'footer.tagline': {
            en: 'Point it at a flower and it gives you the species, how confident it is, and the record behind it.',
            es: 'Apúntalo a una flor y te da la especie, su nivel de confianza y la ficha que lo respalda.',
            fr: 'Visez une fleur et vous obtenez l\'espèce, le degré de confiance et la fiche correspondante.',
            de: 'Richte es auf eine Blume und du bekommst die Art, wie sicher sie ist und den Datensatz dahinter.',
            ja: '花にカメラを向けると、種名と確度、もとになった記録が返ってきます。'
        },
        'footer.product': { en: 'Product', es: 'Producto', fr: 'Produit', de: 'Produkt', ja: 'プロダクト' },
        'footer.project': { en: 'Project', es: 'Proyecto', fr: 'Projet', de: 'Projekt', ja: 'プロジェクト' },
        'footer.datasets': { en: 'Open datasets', es: 'Conjuntos de datos abiertos', fr: 'Jeux de données ouverts', de: 'Offene Datensätze', ja: '公開データセット' },
        'footer.source': { en: 'Source on GitHub', es: 'Código en GitHub', fr: 'Code source sur GitHub', de: 'Quellcode auf GitHub', ja: 'GitHub のソース' },
        'footer.credit': { en: 'Open botanical reference', es: 'Referencia botánica abierta', fr: 'Référence botanique ouverte', de: 'Offene botanische Referenz', ja: 'オープンな植物リファレンス' },
        'footer.attribution': {
            en: 'Species data from Wikidata & Wikipedia, CC0 / CC BY-SA',
            es: 'Datos de especies de Wikidata y Wikipedia, CC0 / CC BY-SA',
            fr: 'Données d\'espèces issues de Wikidata et Wikipédia, CC0 / CC BY-SA',
            de: 'Artdaten aus Wikidata und Wikipedia, CC0 / CC BY-SA',
            ja: '種のデータは Wikidata と Wikipedia より、CC0 / CC BY-SA'
        }
    };

    function stored() {
        var code = null;
        try { code = localStorage.getItem(KEY); } catch (e) { }
        return CODES.indexOf(code) === -1 ? 'en' : code;
    }

    var current = stored();

    function t(key) {
        var row = STRINGS[key];
        if (!row) return '';
        return row[current] || row.en || '';
    }

    // A missing key leaves the markup alone, so an English string still shows
    // instead of an empty element.
    function apply(root) {
        var scope = root || document;
        var text = scope.querySelectorAll('[data-i18n]');
        for (var i = 0; i < text.length; i++) {
            var value = t(text[i].getAttribute('data-i18n'));
            if (value) text[i].textContent = value;
        }
        var labels = scope.querySelectorAll('[data-i18n-aria]');
        for (var j = 0; j < labels.length; j++) {
            var label = t(labels[j].getAttribute('data-i18n-aria'));
            if (label) labels[j].setAttribute('aria-label', label);
        }
        document.documentElement.lang = current;
    }

    function set(code) {
        if (CODES.indexOf(code) === -1) return current;
        current = code;
        try { localStorage.setItem(KEY, code); } catch (e) { }
        apply(document);
        return current;
    }

    window.ffI18n = {
        codes: CODES.slice(),
        lang: function () { return current; },
        set: set,
        t: t,
        apply: apply
    };

    document.documentElement.lang = current;

    function paint() { apply(document); }

    paint();

    // The header, drawer and footer are built by their own scripts after this one
    // runs, so there is a second pass once they are on the page.
    if (document.readyState !== 'complete') {
        document.addEventListener('DOMContentLoaded', paint);
    }
})();
