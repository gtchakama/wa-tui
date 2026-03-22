class WaTui < Formula
  desc "Terminal UI for WhatsApp Web"
  homepage "https://github.com/gtchakama/wa-tui"
  url "https://github.com/gtchakama/wa-tui/archive/refs/tags/v1.7.0.tar.gz"
  license "ISC"

  livecheck do
    url :stable
    regex(/^v?(\d+(?:\.\d+)+)$/i)
  end

  head "https://github.com/gtchakama/wa-tui.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_predicate bin/"wa-tui", :executable?
  end
end
