//! Tycoon's board and cards (`tycoon/board.ts`, copied as data: the same spaces, prices, rents
//! and card texts, in the same order).

/// A space's kind and its numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Start.
    Start,
    /// Jail (just visiting).
    Jail,
    /// Coffee Break.
    Parking,
    /// Go to Jail.
    GoToJail,
    /// A coloured place: group, price, rents (0–4 houses, hotel), house cost.
    Property {
        /// Its colour group.
        group: &'static str,
        /// What it costs.
        price: i64,
        /// Rent with 0–4 houses, then a hotel.
        rent: [i64; 6],
        /// What a house costs.
        house: i64,
    },
    /// A station.
    Station {
        /// What it costs.
        price: i64,
    },
    /// A utility (`power` or `water`).
    Utility {
        /// What it costs.
        price: i64,
        /// `power` or `water`.
        icon: &'static str,
    },
    /// A tax.
    Tax {
        /// What it costs.
        amount: i64,
    },
    /// Draw a Surprise card.
    Surprise,
    /// Draw a Treasure card.
    Treasure,
}

/// A space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Space {
    /// Its name.
    pub name: &'static str,
    /// The city (coloured places).
    pub city: &'static str,
    /// What it is.
    pub kind: Kind,
}

/// The 40 spaces.
pub const SPACES: [Space; 40] = [
    Space {
        name: "Start",
        city: "",
        kind: Kind::Start,
    },
    Space {
        name: "Khao San Road",
        city: "Bangkok",
        kind: Kind::Property {
            group: "brown",
            price: 600,
            rent: [20, 100, 300, 900, 1600, 2500],
            house: 500,
        },
    },
    Space {
        name: "Treasure",
        city: "",
        kind: Kind::Treasure,
    },
    Space {
        name: "Grand Bazaar",
        city: "Istanbul",
        kind: Kind::Property {
            group: "brown",
            price: 600,
            rent: [40, 200, 600, 1800, 3200, 4500],
            house: 500,
        },
    },
    Space {
        name: "Income Tax",
        city: "",
        kind: Kind::Tax { amount: 2000 },
    },
    Space {
        name: "Central Station",
        city: "",
        kind: Kind::Station { price: 2000 },
    },
    Space {
        name: "La Rambla",
        city: "Barcelona",
        kind: Kind::Property {
            group: "sky",
            price: 1000,
            rent: [60, 300, 900, 2700, 4000, 5500],
            house: 500,
        },
    },
    Space {
        name: "Surprise",
        city: "",
        kind: Kind::Surprise,
    },
    Space {
        name: "Copacabana",
        city: "Rio de Janeiro",
        kind: Kind::Property {
            group: "sky",
            price: 1000,
            rent: [60, 300, 900, 2700, 4000, 5500],
            house: 500,
        },
    },
    Space {
        name: "Nyhavn",
        city: "Copenhagen",
        kind: Kind::Property {
            group: "sky",
            price: 1200,
            rent: [80, 400, 1000, 3000, 4500, 6000],
            house: 500,
        },
    },
    Space {
        name: "Jail",
        city: "",
        kind: Kind::Jail,
    },
    Space {
        name: "Nanjing Road",
        city: "Shanghai",
        kind: Kind::Property {
            group: "pink",
            price: 1400,
            rent: [100, 500, 1500, 4500, 6250, 7500],
            house: 1000,
        },
    },
    Space {
        name: "Power Grid",
        city: "",
        kind: Kind::Utility {
            price: 1500,
            icon: "power",
        },
    },
    Space {
        name: "Orchard Road",
        city: "Singapore",
        kind: Kind::Property {
            group: "pink",
            price: 1400,
            rent: [100, 500, 1500, 4500, 6250, 7500],
            house: 1000,
        },
    },
    Space {
        name: "Bondi Beach",
        city: "Sydney",
        kind: Kind::Property {
            group: "pink",
            price: 1600,
            rent: [120, 600, 1800, 5000, 7000, 9000],
            house: 1000,
        },
    },
    Space {
        name: "Metro Line",
        city: "",
        kind: Kind::Station { price: 2000 },
    },
    Space {
        name: "Unter den Linden",
        city: "Berlin",
        kind: Kind::Property {
            group: "orange",
            price: 1800,
            rent: [140, 700, 2000, 5500, 7500, 9500],
            house: 1000,
        },
    },
    Space {
        name: "Treasure",
        city: "",
        kind: Kind::Treasure,
    },
    Space {
        name: "Dam Square",
        city: "Amsterdam",
        kind: Kind::Property {
            group: "orange",
            price: 1800,
            rent: [140, 700, 2000, 5500, 7500, 9500],
            house: 1000,
        },
    },
    Space {
        name: "Gran Vía",
        city: "Madrid",
        kind: Kind::Property {
            group: "orange",
            price: 2000,
            rent: [160, 800, 2200, 6000, 8000, 10000],
            house: 1000,
        },
    },
    Space {
        name: "Coffee Break",
        city: "",
        kind: Kind::Parking,
    },
    Space {
        name: "Myeongdong",
        city: "Seoul",
        kind: Kind::Property {
            group: "red",
            price: 2200,
            rent: [180, 900, 2500, 7000, 8750, 10500],
            house: 1500,
        },
    },
    Space {
        name: "Surprise",
        city: "",
        kind: Kind::Surprise,
    },
    Space {
        name: "Marine Drive",
        city: "Mumbai",
        kind: Kind::Property {
            group: "red",
            price: 2200,
            rent: [180, 900, 2500, 7000, 8750, 10500],
            house: 1500,
        },
    },
    Space {
        name: "Oxford Street",
        city: "London",
        kind: Kind::Property {
            group: "red",
            price: 2400,
            rent: [200, 1000, 3000, 7500, 9250, 11000],
            house: 1500,
        },
    },
    Space {
        name: "Airport Express",
        city: "",
        kind: Kind::Station { price: 2000 },
    },
    Space {
        name: "Via del Corso",
        city: "Rome",
        kind: Kind::Property {
            group: "yellow",
            price: 2600,
            rent: [220, 1100, 3300, 8000, 9750, 11500],
            house: 1500,
        },
    },
    Space {
        name: "The Strip",
        city: "Las Vegas",
        kind: Kind::Property {
            group: "yellow",
            price: 2600,
            rent: [220, 1100, 3300, 8000, 9750, 11500],
            house: 1500,
        },
    },
    Space {
        name: "Water Works",
        city: "",
        kind: Kind::Utility {
            price: 1500,
            icon: "water",
        },
    },
    Space {
        name: "Champs-Élysées",
        city: "Paris",
        kind: Kind::Property {
            group: "yellow",
            price: 2800,
            rent: [240, 1200, 3600, 8500, 10250, 12000],
            house: 1500,
        },
    },
    Space {
        name: "Go to Jail",
        city: "",
        kind: Kind::GoToJail,
    },
    Space {
        name: "Rodeo Drive",
        city: "Beverly Hills",
        kind: Kind::Property {
            group: "green",
            price: 3000,
            rent: [260, 1300, 3900, 9000, 11000, 12750],
            house: 2000,
        },
    },
    Space {
        name: "Ginza",
        city: "Tokyo",
        kind: Kind::Property {
            group: "green",
            price: 3000,
            rent: [260, 1300, 3900, 9000, 11000, 12750],
            house: 2000,
        },
    },
    Space {
        name: "Treasure",
        city: "",
        kind: Kind::Treasure,
    },
    Space {
        name: "Sheikh Zayed Road",
        city: "Dubai",
        kind: Kind::Property {
            group: "green",
            price: 3200,
            rent: [280, 1500, 4500, 10000, 12000, 14000],
            house: 2000,
        },
    },
    Space {
        name: "Harbour Port",
        city: "",
        kind: Kind::Station { price: 2000 },
    },
    Space {
        name: "Surprise",
        city: "",
        kind: Kind::Surprise,
    },
    Space {
        name: "Fifth Avenue",
        city: "New York",
        kind: Kind::Property {
            group: "navy",
            price: 3500,
            rent: [350, 1750, 5000, 11000, 13000, 15000],
            house: 2000,
        },
    },
    Space {
        name: "Luxury Tax",
        city: "",
        kind: Kind::Tax { amount: 1000 },
    },
    Space {
        name: "Monte Carlo",
        city: "Monaco",
        kind: Kind::Property {
            group: "navy",
            price: 4000,
            rent: [500, 2000, 6000, 14000, 17000, 20000],
            house: 2000,
        },
    },
];

/// Card effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// + gets, − pays the bank.
    Money(i64),
    /// + every other player pays you, − you pay each.
    Each(i64),
    /// Go to a space (Start money when passing it).
    MoveTo(usize),
    /// Go back.
    Back(usize),
    /// The nearest station (true) or utility (false).
    Nearest(bool),
    /// Go to jail.
    Jail,
    /// Get out of jail free.
    JailFree,
    /// Pay per house and per hotel.
    Repairs(i64, i64),
}

/// A card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Card {
    /// What it says.
    pub text: &'static str,
    /// What it does.
    pub effect: Effect,
}

/// Surprise cards.
pub const SURPRISE: [Card; 16] = [
    Card {
        text: "Your startup got funded! Advance to Start.",
        effect: Effect::MoveTo(0),
    },
    Card {
        text: "Weekend in Paris: go to Champs-Élysées.",
        effect: Effect::MoveTo(29),
    },
    Card {
        text: "Shopping spree: head to Oxford Street.",
        effect: Effect::MoveTo(24),
    },
    Card {
        text: "Catch a train: go to Central Station.",
        effect: Effect::MoveTo(5),
    },
    Card {
        text: "Feeling lucky? Head to Monte Carlo.",
        effect: Effect::MoveTo(39),
    },
    Card {
        text: "Rush to the nearest station. If someone owns it, pay them double.",
        effect: Effect::Nearest(true),
    },
    Card {
        text: "Rush to the nearest station. If someone owns it, pay them double.",
        effect: Effect::Nearest(true),
    },
    Card {
        text: "Go to the nearest utility. If owned, pay 10× your dice roll.",
        effect: Effect::Nearest(false),
    },
    Card {
        text: "Your shares paid a dividend. Collect $500.",
        effect: Effect::Money(500),
    },
    Card {
        text: "Lucky escape! Keep this card to get out of jail free.",
        effect: Effect::JailFree,
    },
    Card {
        text: "Wrong turn at the roundabout. Go back 3 spaces.",
        effect: Effect::Back(3),
    },
    Card {
        text: "Caught running a red light. Go straight to Jail.",
        effect: Effect::Jail,
    },
    Card {
        text: "Storm damage: pay $250 per house and $1,000 per hotel.",
        effect: Effect::Repairs(250, 1000),
    },
    Card {
        text: "Speeding ticket: pay $150.",
        effect: Effect::Money(-150),
    },
    Card {
        text: "You were elected club chairperson. Pay each player $500.",
        effect: Effect::Each(-500),
    },
    Card {
        text: "Your savings bond matured. Collect $1,500.",
        effect: Effect::Money(1500),
    },
];

/// Treasure cards.
pub const TREASURE: [Card; 16] = [
    Card {
        text: "Holiday bonus! Advance to Start.",
        effect: Effect::MoveTo(0),
    },
    Card {
        text: "The bank made a mistake in your favour. Collect $2,000.",
        effect: Effect::Money(2000),
    },
    Card {
        text: "Dentist visit. Pay $500.",
        effect: Effect::Money(-500),
    },
    Card {
        text: "You sold some old gold. Collect $500.",
        effect: Effect::Money(500),
    },
    Card {
        text: "A wise elder’s blessing: keep this card to get out of jail free.",
        effect: Effect::JailFree,
    },
    Card {
        text: "Tax raid! Go straight to Jail.",
        effect: Effect::Jail,
    },
    Card {
        text: "It’s your birthday! Collect $100 from every player.",
        effect: Effect::Each(100),
    },
    Card {
        text: "Income tax refund. Collect $200.",
        effect: Effect::Money(200),
    },
    Card {
        text: "Your life insurance matured. Collect $1,000.",
        effect: Effect::Money(1000),
    },
    Card {
        text: "Hospital bill. Pay $1,000.",
        effect: Effect::Money(-1000),
    },
    Card {
        text: "School fees are due. Pay $500.",
        effect: Effect::Money(-500),
    },
    Card {
        text: "Freelance project paid off. Collect $250.",
        effect: Effect::Money(250),
    },
    Card {
        text: "Building maintenance: pay $400 per house and $1,150 per hotel.",
        effect: Effect::Repairs(400, 1150),
    },
    Card {
        text: "Second prize in a baking contest! Collect $100.",
        effect: Effect::Money(100),
    },
    Card {
        text: "An uncle left you some savings. Collect $1,000.",
        effect: Effect::Money(1000),
    },
    Card {
        text: "You won the office lottery. Collect $1,000.",
        effect: Effect::Money(1000),
    },
];

/// The Jail square.
pub const JAIL: usize = 10;
/// Go to Jail.
pub const GO_TO_JAIL: usize = 30;
/// Passing Start.
pub const START_PAY: i64 = 2000;
/// Everyone's cash at the start.
pub const START_CASH: i64 = 15000;
/// Leaving jail.
pub const JAIL_FINE: i64 = 500;
/// Station rent for 1–4 owned.
pub const STATION_RENT: [i64; 4] = [250, 500, 1000, 2000];
/// × dice total for 1 or 2 utilities owned.
pub const UTILITY_TIMES: [i64; 2] = [40, 100];
/// The stations.
pub const STATIONS: [usize; 4] = [5, 15, 25, 35];
/// The utilities.
pub const UTILITIES: [usize; 2] = [12, 28];
/// Player tokens.
pub const TOKENS: [&str; 6] = ["auto", "car", "scooter", "boat", "plane", "train"];
/// Player colours.
pub const PLAYER_COLORS: [&str; 6] = ["#e5484d", "#2f7fe0", "#2fa84f", "#f2b705", "#a855f7", "#f97316"];
/// Most players.
pub const MAX_PLAYERS: usize = 6;

/// Group colours.
#[must_use]
pub fn group_color(g: &str) -> &'static str {
    match g {
        "brown" => "#8a5a3c",
        "sky" => "#7cc6ee",
        "pink" => "#d6589a",
        "orange" => "#f08a24",
        "red" => "#e0393e",
        "yellow" => "#f2cb05",
        "green" => "#1f9d55",
        "navy" => "#2a4fb5",
        _ => "#888888",
    }
}

/// Group names as people say them.
#[must_use]
pub fn group_name(g: &str) -> &'static str {
    match g {
        "brown" => "brown",
        "sky" => "light blue",
        "pink" => "pink",
        "orange" => "orange",
        "red" => "red",
        "yellow" => "yellow",
        "green" => "green",
        "navy" => "dark blue",
        _ => "",
    }
}
