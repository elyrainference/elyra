// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title ElyraEscrow
/// @notice Unidirectional payment-channel escrow in an ERC-20 stablecoin (USDG, 6 decimals). A consumer
///         deposits, signs cumulative EIP-712 vouchers off-chain (amounts in token base units), and a
///         provider redeems the latest one. No admin keys, no upgradability. Unaudited.
/// @dev    The token is treated as a plain ERC-20 and nothing more. Fee-on-transfer / rebasing tokens are
///         rejected at deposit (balance delta must equal the amount). If the token blocks a transfer
///         (e.g. a policy revert), redeem/withdraw revert atomically and the funds stay recoverable once
///         the token allows the transfer again. If the token issuer burns escrow balance the escrow can
///         become insolvent; there is no on-chain remedy.
contract ElyraEscrow {
    address public immutable token;

    uint256 public constant WITHDRAW_DELAY = 1 days;
    uint256 public constant WITHDRAW_WINDOW = 7 days;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address consumer,address provider,uint256 cumulative)");
    bytes32 private constant NAME_HASH = keccak256("ElyraEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
    // secp256k1n / 2
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address => uint256) public deposits;
    mapping(address => uint256) public withdrawAt;
    mapping(address => uint256) public withdrawExpires;
    mapping(address => mapping(address => uint256)) public claimed;

    uint256 private _lock = 1;

    event Deposited(address indexed consumer, address indexed funder, uint256 amount);
    event Redeemed(address indexed consumer, address indexed provider, uint256 paid, uint256 cumulativeClaimed);
    event WithdrawRequested(address indexed consumer, uint256 availableAt);
    event WithdrawCancelled(address indexed consumer);
    event Withdrawn(address indexed consumer, uint256 amount);

    error Reentrancy();
    error ZeroAmount();
    error InvalidSignature();
    error BadSignerOrVoucher();
    error NotAboveClaimed();
    error NothingToPay();
    error TransferMismatch();
    error TokenTransferFailed();
    error ZeroAddress();
    error WithdrawNotRequested();
    error WithdrawLocked(uint256 availableAt);
    error InsufficientDeposit();
    error WithdrawExpired();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Pull `amount` tokens from msg.sender (needs prior approval) and credit msg.sender.
    function deposit(uint256 amount) external nonReentrant {
        _deposit(msg.sender, amount);
    }

    /// @notice Pull `amount` tokens from msg.sender and credit `consumer`.
    function depositFor(address consumer, uint256 amount) external nonReentrant {
        if (consumer == address(0)) revert ZeroAddress();
        _deposit(consumer, amount);
    }

    function _deposit(address consumer, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20Min(token).balanceOf(address(this));
        _safeCall(abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), amount)));
        if (IERC20Min(token).balanceOf(address(this)) - before != amount) revert TransferMismatch();
        deposits[consumer] += amount;
        // Only the consumer's own deposit resets a pending exit; a third party cannot cancel it.
        if (msg.sender == consumer && withdrawAt[consumer] != 0) {
            withdrawAt[consumer] = 0;
            withdrawExpires[consumer] = 0;
            emit WithdrawCancelled(consumer);
        }
        emit Deposited(consumer, msg.sender, amount);
    }

    /// @dev Calls the token; accepts empty return data or a true bool, reverts otherwise.
    function _safeCall(bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || token.code.length == 0 || (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenTransferFailed();
        }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function voucherDigest(address consumer, address provider, uint256 cumulative) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, consumer, provider, cumulative));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Provider (msg.sender) redeems a consumer's cumulative voucher.
    /// @dev    KNOWN LIMITATION (by design): the withdraw delay only stops a consumer from *withdrawing*
    ///         directly. A consumer can always drain its deposit by signing a voucher to a second address
    ///         it controls and redeeming it from there; the deposit is shared, first redeemer wins. A
    ///         provider must therefore never be exposed (served but unredeemed) beyond what it can lose,
    ///         and should redeem frequently.
    function redeem(address consumer, uint256 cumulative, bytes calldata sig) external nonReentrant {
        if (consumer == address(0)) revert BadSignerOrVoucher();
        if (_recover(voucherDigest(consumer, msg.sender, cumulative), sig) != consumer) revert BadSignerOrVoucher();

        uint256 already = claimed[consumer][msg.sender];
        if (cumulative <= already) revert NotAboveClaimed();

        uint256 owed = cumulative - already;
        uint256 available = deposits[consumer];
        uint256 paid = owed < available ? owed : available;
        if (paid == 0) revert NothingToPay();

        uint256 total = already + paid;
        claimed[consumer][msg.sender] = total;
        deposits[consumer] = available - paid;
        emit Redeemed(consumer, msg.sender, paid, total);

        _safeCall(abi.encodeCall(IERC20Min.transfer, (msg.sender, paid)));
    }

    /// @notice Start the exit timer: withdrawable from now + WITHDRAW_DELAY until WITHDRAW_WINDOW later.
    function requestWithdraw() external {
        uint256 at = block.timestamp + WITHDRAW_DELAY;
        withdrawAt[msg.sender] = at;
        withdrawExpires[msg.sender] = at + WITHDRAW_WINDOW;
        emit WithdrawRequested(msg.sender, at);
    }

    function cancelWithdraw() external {
        withdrawAt[msg.sender] = 0;
        withdrawExpires[msg.sender] = 0;
        emit WithdrawCancelled(msg.sender);
    }

    /// @notice Single-use: succeeds only inside [withdrawAt, withdrawExpires]; clears the request.
    function withdraw(uint256 amount) external nonReentrant {
        uint256 at = withdrawAt[msg.sender];
        if (at == 0) revert WithdrawNotRequested();
        if (block.timestamp < at) revert WithdrawLocked(at);
        if (block.timestamp > withdrawExpires[msg.sender]) revert WithdrawExpired();
        if (amount > deposits[msg.sender]) revert InsufficientDeposit();
        withdrawAt[msg.sender] = 0;
        withdrawExpires[msg.sender] = 0;
        deposits[msg.sender] -= amount;
        emit Withdrawn(msg.sender, amount);
        _safeCall(abi.encodeCall(IERC20Min.transfer, (msg.sender, amount)));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N) revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
