# Go 1.27 的 generic methods：为什么等了这么久，它真正改变了什么

<!-- tags: Go, Generics, Generic Methods, API Design -->

Go 1.18 把泛型带进 Go 之后，很多人第一时间期待的是集合、stream、parser、builder 这些 API 能写得更自然。但真正开始设计库的时候，很快会遇到一个有点别扭的限制：**类型可以有类型参数，函数可以有类型参数，但方法不能声明自己的类型参数。**

也就是说，你可以写：

```go
type Stream[T any] struct {
  items []T
}

func Map[T, U any](s Stream[T], fn func(T) U) Stream[U] {
  // ...
}
```

但过去不能把 `U` 放在方法上，写成更符合直觉的：

```go
func (s Stream[T]) Map[U any](fn func(T) U) Stream[U] {
  // ...
}
```

Go 1.27 补上的 generic methods，解决的正是这个缺口。它不是让 Go 变成 C++，也不是把 TypeScript 那套结构化类型系统搬进来，也不是要复制 Rust 的 trait 体系；更准确地说，它让一类原本只能写成包级泛型函数的 API，终于可以回到类型自己的命名空间里。

这篇文章重点不放在“语法终于支持了”这种表层结论，而是解释三件事：

1. Go 1.27 的泛型方法到底改变了什么。
2. 同样的能力在 C++、TypeScript 和 Rust 里是什么样子。
3. 即使有了泛型方法，Go 泛型还有哪些明显的边界和改进空间。

## 一、先看变化：方法也能声明自己的类型参数

Go 1.27 之前，泛型能力大概可以分成两类。

<!-- table-svg: generic-methods-capability.svg -->
| 能力             | Go 1.18 到 Go 1.26                                 | Go 1.27                         |
| ---------------- | -------------------------------------------------- | ------------------------------- |
| 泛型类型         | 支持，例如 `type Set[T comparable] map[T]struct{}` | 继续支持                        |
| 泛型函数         | 支持，例如 `func Map[T, U any](...) ...`           | 继续支持                        |
| 泛型方法         | 方法只能使用接收者类型已有的类型参数               | 方法可以声明自己的类型参数      |
| 接口方法类型参数 | 不支持                                             | 仍然不建议理解为完整 trait 系统 |
| 高阶类型参数     | 不支持                                             | 仍不支持                        |

最重要的区别在第三行。以前一个方法可以使用接收者类型上的 `T`：

```go
type Box[T any] struct {
  value T
}

func (b Box[T]) Value() T {
  return b.value
}
```

这里的 `T` 来自 `Box[T]`，不是方法自己声明的类型参数。这个能力从 Go 1.18 起就有。

真正缺的是这种写法：

```go
func (b Box[T]) Map[U any](fn func(T) U) Box[U] {
  return Box[U]{value: fn(b.value)}
}
```

`T` 属于接收者类型，`U` 属于方法本身。`Map` 的语义是：我拿到一个 `Box[T]`，通过一个转换函数，把它变成 `Box[U]`。这类“接收者固定、返回类型变化”的 API，正是泛型方法最自然的使用场景。

如果只看功能，过去也能做到。你可以写包级函数：

```go
func MapBox[T, U any](b Box[T], fn func(T) U) Box[U] {
  return Box[U]{value: fn(b.value)}
}
```

但 API 形态不一样。`box.Map(...)` 和 `MapBox(box, ...)` 的差异，不只是少传一个参数，而是这个操作到底属于谁。

对库作者来说，命名空间很重要。方法会出现在类型的文档页、自动补全列表和调用链里。包级函数则散在包级命名空间中，需要用户知道“这个类型还有一个外部 helper 可以用”。泛型方法补上的，是 Go 泛型在 API 组织上的一块缺口。

## 二、为什么之前不能写：问题不只是语法

如果从别的语言过来，可能会觉得这件事很奇怪：C++ 可以写成员函数模板，TypeScript 可以写 generic method，为什么 Go 一开始不支持？

原因不只是语法保守。Go 的方法和接口有一套很核心的机制：**方法集决定一个类型是否实现某个接口。** 泛型方法一旦加入，就会让方法集、接口匹配、实例化、链接和反射都变得更复杂。

看一个简单例子：

```go
type Mapper[T any] interface {
  Map[U any](func(T) U) Stream[U]
}
```

如果接口方法允许声明自己的类型参数，就会出现一个问题：一个具体类型实现这个接口，是否意味着它必须对所有可能的 `U` 都有合法实现？编译器什么时候实例化这些方法？如果调用点通过接口动态派发，实际的 `U` 又应该在哪里确定？

C++ 的答案很直接：模板基本是编译期展开，能看到调用点就实例化，看不到就不生成。它牺牲的是编译模型复杂度、错误信息长度和二进制膨胀风险。

TypeScript 的答案也很直接：类型系统只在编译期工作，运行时 JavaScript 没有这些泛型。它不需要为每个 `U` 生成不同机器码，也不用解决 Go 那种接口动态派发和编译产物链接问题。

Go 的位置夹在中间。它既要保留清晰的包级编译和接口语义，又要让泛型不把编译器、链接器、运行时和工具链拖进过度复杂的设计里。这就是为什么 generic methods 晚到很多年。

Go 1.27 的变化可以理解成一个谨慎落点：让具体类型的方法可以声明自己的类型参数，先解决 API 设计里最常见的痛点；但它并不意味着 Go 接口系统要变成另一套 trait 或 type class。

## 三、一个完整的 Go 例子：从包级函数到方法链

先写一个很小的 `Stream` 类型：

```go
package stream

type Stream[T any] struct {
  items []T
}

func FromSlice[T any](items []T) Stream[T] {
  copied := append([]T(nil), items...)
  return Stream[T]{items: copied}
}

func (s Stream[T]) Slice() []T {
  return append([]T(nil), s.items...)
}
```

在 Go 1.27 之前，类型变化的操作通常要写成包级函数：

```go
func Map[T, U any](s Stream[T], fn func(T) U) Stream[U] {
  out := make([]U, 0, len(s.items))
  for _, item := range s.items {
    out = append(out, fn(item))
  }
  return Stream[U]{items: out}
}

func Filter[T any](s Stream[T], keep func(T) bool) Stream[T] {
  out := make([]T, 0, len(s.items))
  for _, item := range s.items {
    if keep(item) {
      out = append(out, item)
    }
  }
  return Stream[T]{items: out}
}
```

调用端会是这样：

```go
users := []User{
  {Name: "alice", Age: 20},
  {Name: "bob", Age: 17},
}

adults := stream.Filter(stream.FromSlice(users), func(user User) bool {
  return user.Age >= 18
})

names := stream.Map(adults, func(user User) string {
  return user.Name
})
```

这段代码没有问题，而且很 Go。但它有一个明显的 API 形态差异：`Filter` 和 `Map` 是围绕 `Stream` 工作的，却不能放在 `Stream` 的方法集合里。

有了泛型方法后，`Filter` 这种不改变元素类型的方法本来就可以是方法，`Map` 这种会引入新类型参数的方法也可以回到方法上：

```go
func (s Stream[T]) Filter(keep func(T) bool) Stream[T] {
  out := make([]T, 0, len(s.items))
  for _, item := range s.items {
    if keep(item) {
      out = append(out, item)
    }
  }
  return Stream[T]{items: out}
}

func (s Stream[T]) Map[U any](fn func(T) U) Stream[U] {
  out := make([]U, 0, len(s.items))
  for _, item := range s.items {
    out = append(out, fn(item))
  }
  return Stream[U]{items: out}
}
```

调用端变成：

```go
names := stream.FromSlice(users).
  Filter(func(user User) bool {
    return user.Age >= 18
  }).
  Map(func(user User) string {
    return user.Name
  }).
  Slice()
```

这里的收益不是“看起来像函数式编程”这么简单。更实际的收益是：

- `Map` 出现在 `Stream[T]` 的方法文档里。
- IDE 能在 `Stream[T]` 后面直接补全 `Map`。
- `Map` 的所有权更清楚：它是 `Stream` 的一部分，不是包里随手放的 helper。
- 迁移到新元素类型 `U` 的逻辑不用破坏方法链。

当然，这也不意味着所有代码都应该写成链式调用。如果链太长、每一步都隐式改变类型，读起来会很累。泛型方法给的是能力，不是风格许可。

## 四、C++ 怎么做：成员函数模板非常自由，也非常重

C++ 很早就支持成员函数模板。对应 Go 的例子，可以写成这样：

```cpp
#include <functional>
#include <string>
#include <utility>
#include <vector>

template <typename T>
class Stream {
public:
  explicit Stream(std::vector<T> items) : items_(std::move(items)) {}

  template <typename U>
  Stream<U> map(std::function<U(const T&)> fn) const {
    std::vector<U> out;
    out.reserve(items_.size());

    for (const auto& item : items_) {
      out.push_back(fn(item));
    }

    return Stream<U>(std::move(out));
  }

private:
  std::vector<T> items_;
};
```

调用时：

```cpp
struct User {
  std::string name;
  int age;
};

auto names = Stream<User>({{"alice", 20}, {"bob", 17}})
  .map<std::string>([](const User& user) {
    return user.name;
  });
```

C++ 的模板非常强。成员函数模板只是它的一小部分。你还可以做偏特化、SFINAE、concepts、模板模板参数、编译期计算，甚至把大量逻辑都推到类型系统里。

这套能力的好处是表达力极强。标准库里的容器、迭代器、算法、智能指针，现代 C++ 里的 ranges、concepts，很多都建立在这种编译期泛型能力之上。

但代价也很明确：

- 模板实例化会增加编译成本。
- 错误信息可能穿透很多层模板。
- ABI、头文件暴露和二进制体积都需要额外关注。
- 复杂模板库经常需要读者理解一整套元编程约定。

Go 的泛型方法显然不是在追这个方向。Go 更关心的是让常见库 API 更顺手，同时尽量保留简单的编译模型和可读的错误边界。

所以，用 C++ 类比 Go 1.27 的泛型方法时，最好只类比“成员函数可以有自己的类型参数”这一点，不要顺手把 C++ 模板元编程的整套能力都投射到 Go 上。

## 五、TypeScript 怎么做：语法自然，但运行时没有泛型

TypeScript 的 generic method 写法更接近很多人对这件事的直觉：

```ts
class Stream<T> {
  constructor(private readonly items: T[]) {}

  map<U>(fn: (item: T) => U): Stream<U> {
  return new Stream(this.items.map(fn));
  }

  filter(fn: (item: T) => boolean): Stream<T> {
  return new Stream(this.items.filter(fn));
  }

  toArray(): T[] {
  return [...this.items];
  }
}
```

调用端：

```ts
type User = {
  name: string;
  age: number;
};

const names = new Stream<User>([
  { name: "alice", age: 20 },
  { name: "bob", age: 17 },
])
  .filter((user) => user.age >= 18)
  .map((user) => user.name)
  .toArray();
```

这就是很多前端和 Node.js 开发者熟悉的体验：`T` 是类的类型参数，`U` 是 `map` 方法自己的类型参数。TypeScript 的类型推断通常可以从回调返回值推断出 `U`，调用端很少需要显式写 `map<string>`。

但 TypeScript 和 Go 的根本差异在运行时。TypeScript 编译成 JavaScript 后，泛型会被擦除。运行时只有普通对象、数组和函数，不存在 `Stream<User>` 或 `Stream<string>` 的不同机器码，也没有 Go 那样的接口方法集匹配问题。

这让 TypeScript 的类型系统可以更激进：

- 支持结构化类型。
- 支持条件类型、映射类型、模板字面量类型。
- 支持类型层面的组合和变换。
- 支持非常强的上下文推断。

代价是类型系统和运行时之间存在天然缝隙。一个值在 TypeScript 里看起来是 `User`，运行时未必真满足这个结构。很多边界仍需要 schema validation、runtime check 或协议约束来兜底。

Go 的泛型方法更保守。它不会让类型系统变成一套可编程语言，也不会把运行时检查藏在类型声明后面。它只是让已经存在的静态类型能力，在方法这个位置补齐表达方式。

## 六、Rust 怎么做：泛型方法很自然，但 trait object 有边界

Rust 也支持泛型方法，而且这种能力在日常代码里非常常见。一个类型本身可以是泛型的，方法也可以继续声明自己的泛型参数。

还是用 `Stream<T>` 举例：

```rust
pub struct Stream<T> {
  items: Vec<T>,
}

impl<T> Stream<T> {
  pub fn new(items: Vec<T>) -> Self {
    Self { items }
  }

  pub fn map<U, F>(self, mut f: F) -> Stream<U>
  where
    F: FnMut(T) -> U,
  {
    let items = self.items.into_iter().map(|item| f(item)).collect();
    Stream { items }
  }

  pub fn into_vec(self) -> Vec<T> {
    self.items
  }
}
```

调用端：

```rust
struct User {
  name: String,
  age: u8,
}

let users = vec![
  User {
    name: "alice".to_string(),
    age: 20,
  },
  User {
    name: "bob".to_string(),
    age: 17,
  },
];

let names = Stream::new(users)
  .map(|user| user.name)
  .into_vec();
```

这里 `T` 属于 `Stream<T>`，`U` 和 `F` 属于 `map` 方法。`F` 是回调函数类型，约束为 `FnMut(T) -> U`。Rust 的类型推断通常能从闭包返回值推出 `U`，调用端不需要显式写 `map::<String, _>(...)`。

Rust 的泛型方法不只可以写在具体类型的 `impl` 上，也可以写进 trait：

```rust
trait Mapper<T> {
  fn map<U, F>(self, f: F) -> Stream<U>
  where
    F: FnMut(T) -> U;
}
```

但这也带来一个重要边界：带泛型方法的 trait 通常不能直接当作 `dyn Trait` 使用，因为动态派发需要一张明确的方法表，而泛型方法理论上可以为很多不同的 `U` 和 `F` 实例化。Rust 把这个问题放在 object safety 规则里处理。

这点和 Go 的讨论很接近。Go 的接口也高度依赖方法集和动态派发。如果让接口方法随意声明自己的类型参数，就会遇到类似的“动态派发时如何处理无限多实例化”的问题。只是 Rust 通过 monomorphization、trait bound、object safety 把边界显式暴露出来；Go 则更倾向于从语言设计上先把复杂组合收住。

所以 Rust 对 Go 1.27 的启发不是“泛型方法应该越强越好”，而是另一点：泛型方法可以很好地服务具体类型 API，但一旦和接口 / trait 的动态分发结合，复杂度会马上上升。

## 七、同一个 API，四种语言的设计取舍

把 Go、C++、TypeScript、Rust 放在一起看，差异会更清楚。

<!-- table-svg: generic-methods-comparison.svg -->
| 语言       | 泛型方法形态                                   | 类型信息                                 | 主要优势                                | 主要代价                                   |
| ---------- | ---------------------------------------------- | ---------------------------------------- | --------------------------------------- | ------------------------------------------ |
| Go 1.27    | `func (s Stream[T]) Map[U any](...) Stream[U]` | 编译期检查，保留 Go 的接口和包级编译模型 | API 组织更自然，复杂度受控              | 表达力仍有限，不能当作 trait / HKT 使用    |
| C++        | `template <typename U> Stream<U> map(...)`     | 编译期模板实例化                         | 表达力极强，零成本抽象空间大            | 编译成本、错误信息和复杂度高               |
| TypeScript | `map<U>(fn: (item: T) => U): Stream<U>`        | 编译期类型，运行时擦除                   | 推断强，类型变换能力丰富，写法自然      | 运行时没有泛型保证，类型可能和真实数据脱节 |
| Rust       | `fn map<U, F>(self, f: F) -> Stream<U>`        | 编译期单态化，trait bound 明确           | 类型安全强，零成本抽象和 trait 组合成熟 | trait object / object safety 边界更复杂    |

这四种设计没有绝对优劣，背后是语言目标不同。

C++ 的泛型服务于系统编程和零成本抽象，它愿意把大量复杂度放到编译期。TypeScript 的泛型服务于 JavaScript 生态里的大型应用工程，它愿意让类型系统更强，但运行时仍然是 JavaScript。Rust 的泛型服务于内存安全和零成本抽象，trait bound、associated types、生命周期和所有权共同决定 API 形态。Go 的泛型服务于普通工程代码的复用和类型安全，它一直在控制特性之间的组合复杂度。

所以 Go 1.27 的 generic methods 不应该被理解成“Go 终于追上 C++ / TypeScript / Rust”。更准确的说法是：Go 在自己的边界内，把一个长期影响 API ergonomics 的限制拿掉了。

## 八、哪些场景最适合用泛型方法

第一类是集合和流式变换。

```go
scores := stream.FromSlice(users).
  Map(func(user User) Score {
    return Score{
      Name:  user.Name,
      Value: user.Points,
    }
  }).
  Slice()
```

这种 API 的特点是接收者很明确：操作属于 `Stream[T]`，并且返回新的 `Stream[U]`。泛型方法能让文档和调用点都更自然。

第二类是解析器组合。

```go
type Parser[T any] struct {
  parse func(input string) (T, string, error)
}

func (p Parser[T]) Then[U any](next func(T) Parser[U]) Parser[U] {
  return Parser[U]{
    parse: func(input string) (U, string, error) {
      value, rest, err := p.parse(input)
      if err != nil {
        var zero U
        return zero, input, err
      }
      return next(value).parse(rest)
    },
  }
}
```

这里 `Parser[T]` 通过 `Then[U]` 组合成 `Parser[U]`。如果写成包级函数，也能工作，但链式组合会明显割裂。

第三类是类型安全的 builder。

```go
type Query[T any] struct {
  table string
}

func (q Query[T]) Select[U any](project func(T) U) Query[U] {
  return Query[U]{table: q.table}
}
```

真实 ORM 或查询构建器会更复杂，但核心思路类似：一个阶段绑定一种类型，下一步转换成另一种类型。泛型方法让这类阶段转换更容易放在类型 API 里。

第四类是 `Result` / `Option` 风格的错误或空值组合。

```go
type Result[T any] struct {
  value T
  err   error
}

func (r Result[T]) Then[U any](fn func(T) Result[U]) Result[U] {
  if r.err != nil {
    return Result[U]{err: r.err}
  }
  return fn(r.value)
}
```

Go 项目不一定要大规模引入这类抽象。很多时候显式 `if err != nil` 仍然更清楚。但对少数领域库来说，泛型方法至少让这类 API 可以在 Go 里写得更完整。

## 九、什么时候不要用泛型方法

泛型方法容易让人产生一种冲动：既然方法可以加类型参数，那是不是所有工具函数都应该搬到类型上？

答案是否定的。

如果一个操作没有明确的接收者所有权，包级函数仍然更好。例如：

```go
func Keys[K comparable, V any](m map[K]V) []K {
  keys := make([]K, 0, len(m))
  for key := range m {
    keys = append(keys, key)
  }
  return keys
}
```

把它硬塞进某个 `Map[K, V]` 包装类型，只是为了获得 `.Keys()` 的调用形式，未必值得。Go 的标准库和生态一直偏向直接数据结构，额外 wrapper 应该有清楚收益。

另一个需要克制的地方是长链式 API。

```go
out := source.
  StepA(...).
  StepB(...).
  StepC(...).
  StepD(...)
```

如果每一步都改变类型，读者可能需要依赖 IDE 才能知道当前表达式到底是什么类型。这样的 API 在 TypeScript 里很常见，在 Go 里则要更谨慎。Go 的代码阅读体验很依赖局部显式性，过度链式调用会抵消泛型方法带来的可读性收益。

泛型方法最适合补齐“这本来就该是这个类型的方法，但之前语法不允许”的场景，而不是制造一套新风格。

## 十、对库作者的迁移建议

如果你维护一个已经使用 Go 泛型的库，升级到 Go 1.27 后可以按这个顺序考虑。

第一，先找出那些名字里带接收者概念的包级函数。

```go
stream.Map(...)
stream.FlatMap(...)
stream.Collect(...)
parser.Then(...)
result.Then(...)
query.Select(...)
```

如果这些函数的第一个参数总是某个泛型类型，并且语义明显属于这个类型，就可以考虑迁到方法上。

第二，不要一次性迁移所有函数。优先处理调用端收益最大的 API，尤其是会改变类型参数、过去无法作为方法存在的操作。

第三，兼容性敏感的库可以保留旧函数作为 wrapper。

```go
func Map[T, U any](s Stream[T], fn func(T) U) Stream[U] {
  return s.Map(fn)
}
```

这样老用户可以继续编译，新用户可以使用更自然的方法形式。等到下一个大版本再移除旧入口。

第四，把文档示例先改掉。泛型方法最直接影响的是 API 可发现性和调用方式，文档比内部实现更重要。

第五，给类型推断写示例测试。很多泛型 API 的真实体验取决于调用端是否需要显式写类型参数。如果用户每次都要写 `.Map[string](...)`，那这个 API 可能还可以继续调整。

## 十一、Go 泛型还需要改进什么

Generic methods 补上了一块很重要的拼图，但 Go 泛型仍然有一些明显边界。

### 1. 更好的约束表达能力

Go 的 constraints 设计比较克制。它能表达类型集合、底层类型、方法集合，但不提供太多类型级计算能力。这让约束保持简单，也让一些高级抽象很难写。

例如，一个库作者可能想表达“任何可以 map 的容器”，并保留容器形状：

```go
// 伪代码：Go 当前并不支持这种高阶类型参数。
func Map[F[_], T, U any](values F[T], fn func(T) U) F[U]
```

这类能力通常被称为 higher-kinded types。Go 目前没有它，所以很多“保留容器形状的通用算法”仍然写不出来。

这不一定是坏事。HKT 会显著提高类型系统复杂度。但对集合库、函数式抽象、effect 系统、通用数据管道来说，这是 Go 泛型表达力的一条硬边界。

### 2. 接口与泛型方法的边界仍然需要谨慎

Go 最重要的抽象机制是接口。泛型方法出现后，大家自然会追问：能不能把 generic method 放进接口里，让不同类型统一实现？

这件事如果做得太激进，会直接影响方法集和动态派发模型。Go 很可能会继续保持保守：让泛型方法主要服务具体类型 API，而不是把接口系统扩展成完整的泛型行为抽象。

这也意味着，有些跨类型抽象仍然更适合用普通泛型函数，而不是接口。

### 3. 类型推断还可以更顺手

Go 的类型推断一直偏向局部、明确、可解释。这个原则很好，但在泛型 API 调用链里，有时会显得保守。

理想状态是，大多数 `Map`、`Then`、`Select` 这类方法都能从回调参数和返回值推断出方法类型参数：

```go
names := users.Map(func(user User) string {
  return user.Name
})
```

如果某些复杂场景需要显式写：

```go
names := users.Map[string](func(user User) string {
  return user.Name
})
```

也可以接受。但如果一个 API 经常需要调用者手写类型参数，说明它的参数设计可能不够贴合 Go 的推断能力。

后续 Go 泛型如果能继续改善方法调用、函数值赋值、约束反推里的类型推断体验，会直接提升泛型库的可用性。

### 4. 标准库泛型容器仍然很少

Go 这些年已经补了 `slices`、`maps`、`cmp`、`iter` 等泛型相关能力，但标准库仍然没有 `Set[T]`、`OrderedMap[K, V]`、`Result[T]` 这类更高层的数据结构。

这符合 Go 一贯的标准库策略：先放基础工具，不急着把风格强的抽象放进去。

但现实是，泛型方法出现后，生态里会更容易出现一批集合、迭代、查询、解析器库。标准库是否需要继续补一些基础容器，至少值得观察。

### 5. 错误信息和工具链体验仍有提升空间

泛型代码一旦套得比较深，错误信息就容易变长。Go 已经比 C++ 模板错误友好很多，但对新手来说，涉及 constraints、方法类型参数、推断失败的报错仍然需要继续打磨。

同样重要的是工具链：

- `gopls` 的补全是否能清楚展示接收者类型参数和方法类型参数。
- `go doc` 是否能把泛型方法的示例组织好。
- 静态分析工具是否能识别不必要的显式类型参数。
- public API diff 工具是否能清楚展示泛型方法变更。

泛型方法不是只改编译器。它会影响文档、补全、重构、lint、测试示例和 API 兼容检查。

## 十二、升级后应该怎么用

如果你只是写业务服务，不需要为了 Go 1.27 立刻重构已有代码。泛型方法的价值主要体现在库 API 和基础组件里。

可以优先关注这些地方：

1. 项目里是否有一批 `MapXxx`、`ConvertXxx`、`ThenXxx` 这样的包级泛型函数。
2. 这些函数是否总是围绕同一个泛型类型工作。
3. 调用端是否因为不能链式表达而出现很多临时变量。
4. 文档里是否需要反复解释“这个函数其实是某个类型的操作”。
5. 迁移成方法后，是否真的更清楚，而不是只显得更花。

对公共库来说，建议把泛型方法当成一次 API 整理机会，而不是一次语法迁移任务。

## 结语：它让 Go 泛型更完整，但没有改变 Go 的性格

Generic methods 是 Go 泛型里一个迟到但重要的能力。

它解决的是一个很具体的问题：当一个操作天然属于某个泛型类型，同时又需要引入新的类型参数时，过去只能写成包级函数；Go 1.27 之后，它可以成为真正的方法。

和 C++ 相比，Go 没有走向模板元编程的深水区。和 TypeScript 相比，Go 也没有追求极强的类型变换表达力。和 Rust 相比，Go 也没有把泛型方法、trait bound、associated types、object safety 组合成一套更强的抽象系统。它选择的是更窄、更工程化的一步：补齐方法位置上的泛型表达，同时继续保持接口、编译模型和工具链的可控性。

所以，generic methods 最适合被看作一种 API 设计工具。它能让集合、parser、builder、result、query 这类库写得更自然，也能让文档和补全体验更好。但它不会替代清晰命名、简单数据结构和显式错误处理。

Go 泛型接下来仍然有很多可以讨论的地方：约束表达、类型推断、接口边界、标准库容器、工具链体验。只是从 Go 1.27 开始，那个最常见、最容易让人疑惑的缺口，终于被补上了。
